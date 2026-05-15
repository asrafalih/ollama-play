const apiBase = import.meta.env.VITE_API_URL ?? "";

async function readJsonFromApi(
  r: Response,
  label: string
): Promise<unknown> {
  const text = await r.text();
  if (import.meta.env.DEV) {
    console.debug(`[api] ${label} ← HTTP ${r.status}, ${text.length} chars`, {
      preview: text.slice(0, 600),
      ...(text.length > 1200 ? { suffix: text.slice(-400) } : {}),
    });
  }
  const trimmed = text.trim();
  if (!trimmed) {
    if (!r.ok) {
      throw new Error(r.statusText || `HTTP ${r.status} (empty body)`);
    }
    throw new SyntaxError(
      `Empty response from ${label} (Unexpected end of JSON input)`
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    console.error(`[api] ${label} JSON.parse failed`, {
      message: e instanceof Error ? e.message : e,
      preview: text.slice(0, 1000),
    });
    throw e;
  }
}

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
};

export type OllamaModel = {
  name: string;
  size?: number;
  modified_at?: string;
  /** From Ollama `POST /api/show`; may be empty on older daemons or after a failed show. */
  capabilities?: string[];
};

export async function fetchModels(): Promise<OllamaModel[]> {
  const r = await fetch(`${apiBase}/api/models`);
  const data = (await readJsonFromApi(r, "GET /api/models")) as {
    models?: OllamaModel[];
    error?: string;
  };
  if (!r.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : r.statusText
    );
  }
  return data.models ?? [];
}

async function* parseSse(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) break;
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (
          signal?.aborted ||
          (e instanceof DOMException && e.name === "AbortError")
        ) {
          break;
        }
        throw e;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const sep = buffer.indexOf("\n\n");
        if (sep === -1) break;
        const block = buffer.slice(0, sep).trim();
        buffer = buffer.slice(sep + 2);
        if (!block.startsWith("data:")) continue;
        const payload = block.replace(/^data:\s*/, "");
        try {
          yield JSON.parse(payload) as Record<string, unknown>;
        } catch (e) {
          if (import.meta.env.DEV) {
            console.warn("[api] SSE data: JSON.parse failed", {
              message: e instanceof Error ? e.message : e,
              payloadPreview: payload.slice(0, 400),
            });
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export type StreamChatOptions = {
  signal?: AbortSignal;
  /** Passed to Ollama for structured JSON output when supported. */
  format?: "json";
};

export async function streamChat(
  model: string,
  messages: ChatMessage[],
  onToken: (t: string) => void,
  opts?: StreamChatOptions
): Promise<void> {
  const r = await fetch(`${apiBase}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(opts?.format ? { format: opts.format } : {}),
    }),
    signal: opts?.signal,
  });
  if (!r.ok) {
    const err = (await readJsonFromApi(r, "POST /api/chat error")) as {
      error?: unknown;
    };
    const msg =
      typeof err.error === "string"
        ? err.error
        : JSON.stringify(err.error ?? r.statusText);
    throw new Error(msg);
  }
  for await (const ev of parseSse(r, opts?.signal)) {
    if (ev.type === "token" && typeof ev.content === "string") {
      onToken(ev.content);
    }
    if (ev.type === "done") break;
  }
}

/** Runs a streaming chat and returns the full assistant text (e.g. JSON mode). */
export async function streamChatCollectText(
  model: string,
  messages: ChatMessage[],
  opts?: StreamChatOptions
): Promise<string> {
  let out = "";
  await streamChat(model, messages, (t) => {
    out += t;
  }, opts);
  return out;
}

export type GenerateResult = {
  imageBase64?: string;
  mimeType?: string;
  response?: string;
  error?: string;
  /** Suggested download name from server (prompt + model + timestamp or Ollama filename). */
  downloadFilename?: string;
};

function generateBody(opts: {
  model: string;
  prompt: string;
  stream: boolean;
  width?: number;
  height?: number;
  steps?: number;
}) {
  return {
    model: opts.model,
    prompt: opts.prompt,
    stream: opts.stream,
    ...(opts.width != null ? { width: opts.width } : {}),
    ...(opts.height != null ? { height: opts.height } : {}),
    ...(opts.steps != null ? { steps: opts.steps } : {}),
  };
}

/** Image / completion: SSE stream (progress + image), then non-stream fallback if needed. */
export async function streamGenerate(opts: {
  model: string;
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  onProgress?: (completed: number, total: number) => void;
  /** Rare for image models; some pipelines stream text chunks. */
  onToken?: (t: string) => void;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const r = await fetch(`${apiBase}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      generateBody({
        model: opts.model,
        prompt: opts.prompt,
        stream: true,
        width: opts.width,
        height: opts.height,
        steps: opts.steps,
      })
    ),
    signal: opts.signal,
  });
  if (!r.ok) {
    const err = (await readJsonFromApi(r, "POST /api/generate error")) as {
      error?: unknown;
    };
    const msg =
      typeof err.error === "string"
        ? err.error
        : JSON.stringify(err.error ?? r.statusText);
    throw new Error(msg);
  }

  let textBuffer = "";
  let out: GenerateResult = {};

  for await (const ev of parseSse(r, opts.signal)) {
    if (
      ev.type === "progress" &&
      typeof ev.completed === "number" &&
      typeof ev.total === "number"
    ) {
      opts.onProgress?.(ev.completed, ev.total);
    }
    if (ev.type === "token" && typeof ev.content === "string") {
      textBuffer += ev.content;
      opts.onToken?.(ev.content);
    }
    const b64FromEv =
      typeof ev.imageBase64 === "string" && ev.imageBase64.length > 0
        ? ev.imageBase64
        : undefined;
    const nameFromEv =
      typeof ev.downloadFilename === "string" && ev.downloadFilename.length > 0
        ? ev.downloadFilename
        : undefined;
    if (ev.type === "image" && b64FromEv) {
      out = {
        imageBase64: b64FromEv,
        mimeType:
          typeof ev.mimeType === "string" ? ev.mimeType : "image/png",
        ...(nameFromEv ? { downloadFilename: nameFromEv } : {}),
      };
    }
    if (ev.type === "done") {
      if (b64FromEv) {
        out = {
          imageBase64: b64FromEv,
          mimeType:
            typeof ev.mimeType === "string" ? ev.mimeType : "image/png",
          ...(nameFromEv ? { downloadFilename: nameFromEv } : {}),
        };
      } else if (typeof ev.warning === "string") {
        out = { error: ev.warning };
      } else if (nameFromEv && out.imageBase64) {
        out = { ...out, downloadFilename: nameFromEv };
      }
    }
  }

  if (out.imageBase64) {
    return out;
  }
  if (textBuffer.trim()) {
    return { response: textBuffer };
  }

  // Some Ollama versions return no image over SSE but return one with stream:false.
  try {
    const r2 = await fetch(`${apiBase}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        generateBody({
          model: opts.model,
          prompt: opts.prompt,
          stream: false,
          width: opts.width,
          height: opts.height,
          steps: opts.steps,
        })
      ),
      signal: opts.signal,
    });
    const data = (await readJsonFromApi(
      r2,
      "POST /api/generate (non-stream fallback)"
    )) as Record<string, unknown>;
    if (r2.ok) {
      const imageB64 =
        typeof data.imageBase64 === "string" && data.imageBase64.length > 0
          ? data.imageBase64
          : typeof data.image === "string" && data.image.length > 0
            ? (data.image as string)
            : undefined;
      if (imageB64) {
        const mimeType =
          typeof data.mimeType === "string" ? data.mimeType : "image/png";
        const downloadFilename =
          typeof data.downloadFilename === "string"
            ? data.downloadFilename
            : undefined;
        return {
          imageBase64: imageB64,
          mimeType,
          ...(downloadFilename ? { downloadFilename } : {}),
        };
      }
      if (typeof data.error === "string" && data.error.length > 0) {
        return { error: data.error };
      }
    }
  } catch {
    // ignore — surface empty result below
  }

  if (typeof out.error === "string" && out.error.trim()) {
    return out;
  }

  return {};
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}
