import "dotenv/config";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { OLLAMA_HOST, PORT } from "./config.js";
import { log } from "./logger.js";
import { stripDataUrlBase64 } from "./normalizeBase64.js";
import { buildImageDownloadFilename } from "./imageDownloadFilename.js";
import { readOllamaJson } from "./readOllamaBody.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "32mb" }));

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    log(`${req.method} ${req.path} → ${res.statusCode}`, {
      ms: Date.now() - t0,
    });
  });
  next();
});

const messageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  images: z.array(z.string()).optional(),
});

const chatFormatSchema = z.union([
  z.literal("json"),
  z.record(z.string(), z.unknown()),
]);

const chatBodySchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional(),
  /** Ollama structured output: `"json"` or a JSON Schema object. */
  format: chatFormatSchema.optional(),
});

const generateBodySchema = z.object({
  model: z.string().min(1),
  prompt: z.string(),
  stream: z.boolean().optional(),
  images: z.array(z.string()).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  steps: z.number().int().positive().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

function ollamaUrl(path: string): string {
  return `${OLLAMA_HOST}${path}`;
}

/**
 * Ollama `/api/generate` NDJSON lines (and final JSON) differ by model/version:
 * image bytes may appear under `image`, `images[]`, or a large `response` on the last chunk.
 */
function pickImageBase64FromOllamaLine(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.image === "string" && obj.image.length > 0) {
    return obj.image;
  }
  const images = obj.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (typeof item === "string" && item.length > 0) return item;
    }
  }
  const resp = obj.response;
  if (typeof resp === "string" && resp.length > 100) {
    const done = obj.done === true;
    if (done || resp.length >= 4000) {
      return resp.trim();
    }
  }
  return undefined;
}

async function fetchCapabilitiesForModel(model: string): Promise<string[]> {
  try {
    const r = await fetch(ollamaUrl("/api/show"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!r.ok) {
      const text = await r.text();
      log("GET /api/models: POST /api/show failed", {
        model,
        status: r.status,
        bodyPreview: text.slice(0, 200),
      });
      return [];
    }
    const data = (await r.json()) as { capabilities?: unknown };
    const cap = data.capabilities;
    if (!Array.isArray(cap)) return [];
    return cap.filter((c): c is string => typeof c === "string");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("GET /api/models: POST /api/show exception", { model, error: msg });
    return [];
  }
}

function normalizeChatMessages(
  messages: z.infer<typeof chatBodySchema>["messages"]
) {
  return messages.map((m) => {
    if (!m.images?.length) return m;
    return {
      ...m,
      images: m.images.map(stripDataUrlBase64),
    };
  });
}

function summarizeChatMessages(
  messages: z.infer<typeof chatBodySchema>["messages"]
) {
  return messages.map((m, i) => ({
    i,
    role: m.role,
    contentChars: m.content.length,
    images: m.images?.length ?? 0,
  }));
}

app.get("/health", (_req, res) => {
  log("health check");
  res.json({ ok: true });
});

app.get("/api/models", async (_req, res) => {
  const url = ollamaUrl("/api/tags");
  log("GET /api/models: fetching Ollama tags", { url });
  try {
    const t0 = Date.now();
    const r = await fetch(url);
    if (!r.ok) {
      const text = await r.text();
      log("GET /api/models: Ollama error", {
        status: r.status,
        bodyPreview: text.slice(0, 200),
        ms: Date.now() - t0,
      });
      return res.status(r.status).json({
        error: `Ollama error: ${text || r.statusText}`,
      });
    }
    const data = await readOllamaJson<{
      models?: { name: string; size?: number; modified_at?: string }[];
    }>(r, "GET /api/tags");
    const models = data.models ?? [];
    const t1 = Date.now();
    const enriched = await Promise.all(
      models.map(async (m) => {
        const capabilities = await fetchCapabilitiesForModel(m.name);
        return { ...m, capabilities };
      })
    );
    log("GET /api/models: ok", {
      count: enriched.length,
      tagsMs: t1 - t0,
      totalMs: Date.now() - t0,
    });
    res.json({ models: enriched });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("GET /api/models: unreachable", { ollama: OLLAMA_HOST, error: msg });
    res.status(502).json({ error: `Cannot reach Ollama at ${OLLAMA_HOST}: ${msg}` });
  }
});

app.post("/api/chat", async (req, res) => {
  const parsed = chatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    log("POST /api/chat: validation failed", {
      issues: parsed.error.flatten(),
    });
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { model, messages, stream, format } = parsed.data;
  const body: Record<string, unknown> = {
    model,
    messages: normalizeChatMessages(messages),
    stream: stream !== false,
  };
  if (format !== undefined) {
    body.format = format;
  }

  log("POST /api/chat: request", {
    model,
    stream: body.stream,
    hasFormat: format !== undefined,
    messageCount: messages.length,
    messages: summarizeChatMessages(messages),
  });

  try {
    const t0 = Date.now();
    const r = await fetch(ollamaUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const text = await r.text();
      log("POST /api/chat: Ollama error", {
        status: r.status,
        ms: Date.now() - t0,
        bodyPreview: text.slice(0, 300),
      });
      return res.status(r.status).json({
        error: text || r.statusText,
      });
    }

    if (!body.stream || !r.body) {
      const data = await readOllamaJson(r, "POST /api/chat (non-stream)");
      log("POST /api/chat: non-stream response", {
        model,
        ms: Date.now() - t0,
        done: (data as { done?: boolean }).done,
      });
      return res.json(data);
    }

    log("POST /api/chat: streaming from Ollama", { model });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let tokenEvents = 0;
    let rawLines = 0;
    let streamHeadLogged = false;

    const sendSse = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const processChatLine = (trimmed: string) => {
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as {
          message?: { content?: string };
          done?: boolean;
        };
        const content = obj.message?.content ?? "";
        if (content) {
          sendSse({ type: "token", content });
          tokenEvents += 1;
        }
        if (obj.done) {
          sendSse({ type: "done" });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("POST /api/chat: NDJSON parse error", {
          message: msg,
          lineChars: trimmed.length,
          linePreview: trimmed.slice(0, 200),
        });
        sendSse({ type: "raw", line: trimmed.slice(0, 500) });
        rawLines += 1;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!streamHeadLogged && chunk.length > 0) {
          streamHeadLogged = true;
          log("POST /api/chat: Ollama stream first bytes", {
            model,
            contentType: r.headers.get("content-type"),
            preview: chunk.slice(0, 500),
          });
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processChatLine(line.trim());
        }
      }
      processChatLine(buffer.trim());
    } finally {
      reader.releaseLock();
    }
    log("POST /api/chat: stream finished", {
      model,
      ms: Date.now() - t0,
      tokenEvents,
      rawLines,
    });
    res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("POST /api/chat: exception", { error: msg });
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    } else {
      res.end();
    }
  }
});

app.post("/api/generate", async (req, res) => {
  const parsed = generateBodySchema.safeParse(req.body);
  if (!parsed.success) {
    log("POST /api/generate: validation failed", {
      issues: parsed.error.flatten(),
    });
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { model, prompt, stream, images, width, height, steps, options } = parsed.data;

  const ollamaBody: Record<string, unknown> = {
    model,
    prompt,
    stream: stream !== false,
  };

  if (images?.length) {
    ollamaBody.images = images.map(stripDataUrlBase64);
  }
  if (width != null) ollamaBody.width = width;
  if (height != null) ollamaBody.height = height;
  if (steps != null) ollamaBody.steps = steps;
  if (options) ollamaBody.options = options;

  log("POST /api/generate: request", {
    model,
    stream: ollamaBody.stream,
    promptPreview: prompt.slice(0, 120),
    promptChars: prompt.length,
    width,
    height,
    steps,
    imageInputs: images?.length ?? 0,
  });

  try {
    const t0 = Date.now();
    const r = await fetch(ollamaUrl("/api/generate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ollamaBody),
    });

    if (!r.ok) {
      const text = await r.text();
      log("POST /api/generate: Ollama error", {
        status: r.status,
        ms: Date.now() - t0,
        bodyPreview: text.slice(0, 300),
      });
      return res.status(r.status).json({
        error: text || r.statusText,
      });
    }

    if (!ollamaBody.stream || !r.body) {
      const data = await readOllamaJson<Record<string, unknown>>(
        r,
        "POST /api/generate (non-stream)"
      );
      const imageB64 = pickImageBase64FromOllamaLine(data);

      log("POST /api/generate: non-stream response", {
        model,
        ms: Date.now() - t0,
        hasImageField: typeof data.image === "string",
        imageBase64Chars: imageB64?.length ?? 0,
        textResponseChars:
          typeof data.response === "string" ? data.response.length : 0,
      });

      const mimeType = imageB64 ? "image/png" : undefined;
      const createdAt =
        typeof data.created_at === "string" ? data.created_at : undefined;
      const downloadFilename =
        imageB64 != null && mimeType
          ? buildImageDownloadFilename(model, prompt, mimeType, createdAt)
          : undefined;

      return res.json({
        ...data,
        imageBase64: imageB64,
        mimeType,
        downloadFilename,
      });
    }

    log("POST /api/generate: streaming from Ollama", {
      model,
      ollamaContentType: r.headers.get("content-type"),
    });
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalImage: string | undefined;
    let lastCreatedAt: string | undefined;
    let ollamaFilenameHint: string | undefined;
    let progressEvents = 0;
    let tokenEvents = 0;
    let streamHeadLogged = false;

    const sendSse = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const resolveDownloadFilename = (mimeType: string): string => {
      if (ollamaFilenameHint) return ollamaFilenameHint;
      return buildImageDownloadFilename(
        model,
        prompt,
        mimeType,
        lastCreatedAt
      );
    };

    const handleNdjsonLine = (trimmed: string) => {
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed) as {
          response?: string;
          image?: string;
          done?: boolean;
          completed?: number;
          total?: number;
          created_at?: string;
          filename?: string;
        };

        if (typeof obj.created_at === "string") {
          lastCreatedAt = obj.created_at;
        }
        if (typeof obj.filename === "string" && obj.filename.length > 0) {
          const base = obj.filename.replace(/\\/g, "/").split("/").pop() ?? "";
          const safe = base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
          if (safe.length > 0) ollamaFilenameHint = safe;
        }

        // Log every line (truncate image field so logs stay readable)
        log("POST /api/generate: NDJSON line", {
          model,
          done: obj.done,
          hasImage: typeof obj.image === "string" && obj.image.length > 0,
          imageChars: typeof obj.image === "string" ? obj.image.length : 0,
          completed: obj.completed,
          total: obj.total,
          hasResponse: !!obj.response,
          responseChars: typeof obj.response === "string" ? obj.response.length : 0,
        });

        const pickedImage = pickImageBase64FromOllamaLine(
          obj as Record<string, unknown>
        );
        if (typeof pickedImage === "string" && pickedImage.length > 0) {
          finalImage = pickedImage;
          const mimeType = "image/png";
          sendSse({
            type: "image",
            imageBase64: pickedImage,
            mimeType,
            downloadFilename: resolveDownloadFilename(mimeType),
          });
        } else if (obj.response) {
          sendSse({ type: "token", content: obj.response });
          tokenEvents += 1;
        }
        // z-image-turbo sends {total:N, done:false} for progress without "completed"
        // so treat "total present but not done" as progress too
        if (obj.total != null && !obj.done) {
          const completed = obj.completed ?? 0;
          sendSse({
            type: "progress",
            completed,
            total: obj.total,
          });
          progressEvents += 1;
        } else if (obj.completed != null && obj.total != null) {
          sendSse({
            type: "progress",
            completed: obj.completed,
            total: obj.total,
          });
          progressEvents += 1;
        }
        if (obj.done) {
          const mimeType = finalImage ? "image/png" : undefined;
          sendSse({
            type: "done",
            imageBase64: finalImage,
            mimeType,
            ...(mimeType
              ? { downloadFilename: resolveDownloadFilename(mimeType) }
              : {}),
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("POST /api/generate: NDJSON parse error", {
          message: msg,
          lineChars: trimmed.length,
          linePreview: trimmed.slice(0, 120),
        });
        sendSse({ type: "raw", line: trimmed.slice(0, 500) });
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!streamHeadLogged && chunk.length > 0) {
          streamHeadLogged = true;
          log("POST /api/generate: Ollama stream first bytes", {
            model,
            preview: chunk.slice(0, 500),
          });
        }
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleNdjsonLine(line.trim());
        }
      }
      // Ollama often omits a trailing newline on the final NDJSON line.
      handleNdjsonLine(buffer.trim());
    } finally {
      reader.releaseLock();
    }
    log("POST /api/generate: stream finished", {
      model,
      ms: Date.now() - t0,
      progressEvents,
      tokenEvents,
      finalImageChars: finalImage?.length ?? 0,
    });

    // Streaming often omits `image` for z-image and similar models; CLI still works via non-stream.
    if (!finalImage) {
      log("POST /api/generate: stream had no image; trying Ollama non-stream (same body as CLI)", {
        model,
        progressEvents,
        tokenEvents,
      });
      try {
        const fallbackBody = { ...ollamaBody, stream: false };
        const rNs = await fetch(ollamaUrl("/api/generate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallbackBody),
        });
        if (rNs.ok) {
          const fr = await readOllamaJson<Record<string, unknown>>(
            rNs,
            "POST /api/generate stream→non-stream fallback"
          );
          const b64 = pickImageBase64FromOllamaLine(fr);
          if (typeof b64 === "string" && b64.length > 0) {
            finalImage = b64;
            const mimeType = "image/png";
            sendSse({
              type: "image",
              imageBase64: finalImage,
              mimeType,
              downloadFilename: resolveDownloadFilename(mimeType),
            });
            sendSse({
              type: "done",
              imageBase64: finalImage,
              mimeType,
              downloadFilename: resolveDownloadFilename(mimeType),
            });
            log("POST /api/generate: non-stream fallback recovered image", {
              model,
              imageChars: finalImage.length,
            });
          } else {
            log("POST /api/generate: non-stream fallback returned no image field", {
              model,
              keys: Object.keys(fr),
            });
          }
        } else {
          const text = await rNs.text();
          log("POST /api/generate: non-stream fallback HTTP error", {
            model,
            status: rNs.status,
            bodyPreview: text.slice(0, 240),
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("POST /api/generate: non-stream fallback exception", { model, error: msg });
      }
    }

    // If Ollama closed the stream without ever sending done:true or an image,
    // emit a done event now so the client isn't left hanging.
    if (!finalImage) {
      log("POST /api/generate: stream + fallback ended without image", {
        model,
        progressEvents,
        tokenEvents,
      });
      sendSse({
        type: "done",
        imageBase64: undefined,
        mimeType: undefined,
        warning: `Ollama stream completed (${progressEvents} steps) but returned no image data. ` +
          `This is a known issue with some Ollama versions and image models. ` +
          `Check that your Ollama version supports image output via the API ` +
          `(run: ollama --version). See https://ollama.com/blog/image-generation for details.`,
      });
    }

    res.end();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("POST /api/generate: exception", { error: msg });
    if (!res.headersSent) {
      res.status(502).json({ error: msg });
    } else {
      res.end();
    }
  }
});

app.listen(PORT, () => {
  log(`listening http://localhost:${PORT} → Ollama ${OLLAMA_HOST}`);
});
