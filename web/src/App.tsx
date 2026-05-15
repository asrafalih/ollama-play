import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatMessage,
  fetchModels,
  fileToDataUrl,
  type OllamaModel,
  streamChat,
  streamGenerate,
} from "./api";
import { buildImageDownloadFilename } from "./imageDownloadFilename";
import {
  DEFAULT_IMAGE_MODEL_PREFERENCES,
  DEFAULT_TEXT_MODEL_PREFERENCES,
  DEFAULT_VISION_MODEL_PREFERENCES,
  filterImageModels,
  filterTextModels,
  filterVisionModels,
  pickDefaultModel,
} from "./modelFilters";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { MarkdownMessage } from "./MarkdownMessage";
import { ModelSelect } from "./ModelSelect";
import { MovieShortsTab } from "./MovieShortsTab";

type ModelTabId = "text" | "vision" | "image";
type TabId = ModelTabId | "shorts";

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

function downloadBase64(b64: string, mime: string, filename: string) {
  const a = document.createElement("a");
  a.href = `data:${mime};base64,${b64}`;
  a.download = filename;
  a.click();
}

function ChatTab({
  title,
  description,
  model,
  models,
  onModelChange,
  modelsLoading,
  allowImages,
}: {
  title: string;
  description: string;
  model: string;
  models: OllamaModel[];
  onModelChange: (v: string) => void;
  modelsLoading: boolean;
  allowImages: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [imagePreview, setImagePreview] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!model || (!text && !imagePreview.length)) return;
    setError(null);
    const userMsg: ChatMessage = {
      role: "user",
      content: text || "(see image)",
      ...(imagePreview.length ? { images: [...imagePreview] } : {}),
    };
    const nextMessages = [...messages, userMsg];
    setMessages([...nextMessages, { role: "assistant", content: "" }]);
    setInput("");
    setImagePreview([]);
    setBusy(true);
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    try {
      await streamChat(
        model,
        nextMessages,
        (t) => {
          setMessages((prev) => {
            const copy = [...prev];
            const last = copy[copy.length - 1];
            if (last?.role === "assistant") {
              copy[copy.length - 1] = { ...last, content: last.content + t };
            }
            return copy;
          });
        },
        { signal }
      );
    } catch (e) {
      if (!isAbortError(e)) {
        setError(e instanceof Error ? e.message : String(e));
        setMessages((prev) => prev.slice(0, -2));
      }
    } finally {
      if (signal.aborted) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.content.trim()) {
            return prev.slice(0, -1);
          }
          return prev;
        });
      }
      abortRef.current = null;
      setBusy(false);
    }
  }, [input, imagePreview, messages, model]);

  const onPickFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const urls: string[] = [];
    for (const f of Array.from(files)) {
      urls.push(await fileToDataUrl(f));
    }
    setImagePreview(urls);
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
        <p className="mt-1 text-sm text-zinc-500">{description}</p>
      </header>
      <ModelSelect
        models={models}
        value={model}
        onChange={onModelChange}
        disabled={modelsLoading}
      />
      {allowImages && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="cursor-pointer rounded-xl border border-dashed border-zinc-600 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-400 transition hover:border-sky-600 hover:text-sky-300">
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void onPickFiles(e.target.files)}
            />
            Attach images
          </label>
          {imagePreview.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {imagePreview.map((src, i) => (
                <img
                  key={i}
                  src={src}
                  alt=""
                  className="h-16 w-16 rounded-lg object-cover ring-1 ring-zinc-700"
                />
              ))}
              <button
                type="button"
                className="text-xs text-zinc-500 underline"
                onClick={() => setImagePreview([])}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
      <div className="min-h-[280px] max-h-[420px] space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/50 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-zinc-600">No messages yet.</p>
        )}
        {messages.map((m, i) => {
          const isPendingAssistant =
            busy &&
            m.role === "assistant" &&
            i === messages.length - 1 &&
            !m.content.trim();
          return (
            <div
              key={i}
              className={`rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "ml-8 bg-sky-950/50 text-sky-100"
                  : "mr-8 bg-zinc-800/80 text-zinc-200"
              }`}
            >
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">
                {m.role}
              </div>
              {m.images?.length ? (
                <div className="mb-2 flex flex-wrap gap-2">
                  {m.images.map((src, j) => (
                    <img
                      key={j}
                      src={
                        src.startsWith("data:")
                          ? src
                          : `data:image/png;base64,${src}`
                      }
                      alt=""
                      className="max-h-32 rounded-md ring-1 ring-zinc-700"
                    />
                  ))}
                </div>
              ) : null}
              {isPendingAssistant ? (
                <ThinkingIndicator />
              ) : m.role === "assistant" ? (
                <MarkdownMessage content={m.content} />
              ) : (
                <div className="whitespace-pre-wrap">{m.content}</div>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <textarea
          className="min-h-[88px] flex-1 resize-y rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
          placeholder={
            allowImages
              ? "Ask about the image(s)…"
              : "Message the model…"
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex shrink-0 flex-col justify-end">
          <button
            type="button"
            disabled={!busy && !model}
            onClick={() => (busy ? stopGeneration() : void send())}
            aria-label={busy ? "Stop" : "Send message"}
            title={busy ? "Stop" : "Send"}
            className={`flex min-h-[2.75rem] min-w-[5.5rem] items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium shadow-lg transition ${
              busy
                ? "border border-amber-600/70 bg-amber-950/80 text-amber-100 shadow-amber-950/30 hover:bg-amber-900/90"
                : "bg-sky-600 text-white shadow-sky-900/30 hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            }`}
          >
            {busy ? (
              <span
                className="block h-3.5 w-3.5 shrink-0 rounded-[2px] bg-current"
                aria-hidden
              />
            ) : (
              "Send"
            )}
          </button>
        </div>
      </div>
      <p className="text-xs text-zinc-600">
        Tip: <kbd className="rounded bg-zinc-800 px-1">⌘</kbd>+
        <kbd className="rounded bg-zinc-800 px-1">Enter</kbd> to send.
      </p>
    </div>
  );
}

function ImageGenTab({
  model,
  models,
  onModelChange,
  modelsLoading,
}: {
  model: string;
  models: OllamaModel[];
  onModelChange: (v: string) => void;
  modelsLoading: boolean;
}) {
  const [prompt, setPrompt] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(768);
  const [steps, setSteps] = useState<number | "">(20);
  const [result, setResult] = useState<{
    b64: string;
    mime: string;
    downloadFilename: string;
  } | null>(null);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = async () => {
    if (!model || !prompt.trim()) return;
    setError(null);
    setResult(null);
    setProgress(null);
    setBusy(true);
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;
    try {
      const data = await streamGenerate({
        model,
        prompt: prompt.trim(),
        width,
        height,
        steps: steps === "" ? undefined : steps,
        onProgress: (completed, total) => setProgress({ completed, total }),
        signal,
      });
      if (signal.aborted) return;
      const b64 = data.imageBase64;
      const mime = data.mimeType ?? "image/png";
      if (!b64) {
        throw new Error(
          data.error
            ? data.error
            : data.response
              ? `Model returned text, not an image: ${data.response.slice(0, 200)}…`
              : "No image in response. Make sure you selected an image generation model (e.g. x/z-image-turbo) and that your Ollama version supports image output via the API."
        );
      }
      const trimmedPrompt = prompt.trim();
      const downloadFilename =
        data.downloadFilename?.trim() ||
        buildImageDownloadFilename(model, trimmedPrompt, mime);
      setResult({ b64, mime, downloadFilename });
    } catch (e) {
      if (!isAbortError(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold text-zinc-100">Image generation</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Uses <code className="text-zinc-400">/api/generate</code> with a{" "}
          <span className="font-semibold text-zinc-400">streaming</span> response (SSE):
          progress updates while generating, then the final image.
        </p>
      </header>
      <ModelSelect
        models={models}
        value={model}
        onChange={onModelChange}
        disabled={modelsLoading}
      />
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-zinc-400">Prompt</span>
        <textarea
          className="min-h-[100px] rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="A sunset over mountains…"
        />
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Width</span>
          <input
            type="number"
            className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
            value={width}
            min={64}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Height</span>
          <input
            type="number"
            className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
            value={height}
            min={64}
            onChange={(e) => setHeight(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Steps</span>
          <input
            type="number"
            className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
            value={steps}
            min={1}
            onChange={(e) =>
              setSteps(e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </label>
      </div>
      {progress && progress.total > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-zinc-500">
            <span>Generating</span>
            <span>
              {progress.completed} / {progress.total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-violet-500 transition-[width] duration-300"
              style={{
                width: `${Math.min(100, (100 * progress.completed) / progress.total)}%`,
              }}
            />
          </div>
        </div>
      )}
      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={!busy && (!model || !prompt.trim())}
          onClick={() => (busy ? stopGeneration() : void run())}
          aria-label={busy ? "Stop generation" : "Generate image"}
          title={busy ? "Stop" : "Generate"}
          className={`flex min-h-[2.75rem] min-w-[8rem] items-center justify-center rounded-xl px-5 py-2.5 text-sm font-medium shadow-lg transition ${
            busy
              ? "border border-amber-600/70 bg-amber-950/80 text-amber-100 shadow-amber-950/30 hover:bg-amber-900/90"
              : "bg-violet-600 text-white shadow-violet-900/30 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
          }`}
        >
          {busy ? (
            <span
              className="block h-3.5 w-3.5 shrink-0 rounded-[2px] bg-current"
              aria-hidden
            />
          ) : (
            "Generate"
          )}
        </button>
      </div>
      {busy && !progress && (
        <ThinkingIndicator label="Generating" className="text-zinc-500" />
      )}
      {result && (
        <div className="space-y-3">
          <img
            src={`data:${result.mime};base64,${result.b64}`}
            alt="Generated"
            className="max-w-full rounded-xl ring-1 ring-zinc-700"
          />
          <button
            type="button"
            className="text-sm text-sky-400 underline"
            onClick={() =>
              downloadBase64(
                result.b64,
                result.mime,
                result.downloadFilename
              )
            }
          >
            Download
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<TabId>("text");
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelByTab, setModelByTab] = useState<Record<ModelTabId, string>>({
    text: "",
    vision: "",
    image: "",
  });
  const [shortsTextModel, setShortsTextModel] = useState("");
  const [shortsImageModel, setShortsImageModel] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchModels();
        if (!cancelled) {
          setModels(list);
          setModelsError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setModelsError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const textModels = useMemo(() => filterTextModels(models), [models]);
  const visionModels = useMemo(() => filterVisionModels(models), [models]);
  const imageModels = useMemo(() => filterImageModels(models), [models]);

  useEffect(() => {
    if (modelsLoading) return;
    setModelByTab((prev) => {
      const next = { ...prev };
      const nameSet = (list: OllamaModel[]) => new Set(list.map((m) => m.name));

      const syncTab = (
        tab: ModelTabId,
        list: OllamaModel[],
        preferences: string[]
      ) => {
        const valid = nameSet(list);
        const current = prev[tab];
        if (!current || !valid.has(current)) {
          next[tab] = pickDefaultModel(list, preferences);
        }
      };

      syncTab("text", textModels, DEFAULT_TEXT_MODEL_PREFERENCES);
      syncTab("vision", visionModels, DEFAULT_VISION_MODEL_PREFERENCES);
      syncTab("image", imageModels, DEFAULT_IMAGE_MODEL_PREFERENCES);

      if (
        next.text === prev.text &&
        next.vision === prev.vision &&
        next.image === prev.image
      ) {
        return prev;
      }
      return next;
    });
  }, [modelsLoading, textModels, visionModels, imageModels]);

  useEffect(() => {
    if (modelsLoading) return;
    const textNames = new Set(textModels.map((m) => m.name));
    const imageNames = new Set(imageModels.map((m) => m.name));
    setShortsTextModel((prev) =>
      prev && textNames.has(prev)
        ? prev
        : pickDefaultModel(textModels, DEFAULT_TEXT_MODEL_PREFERENCES)
    );
    setShortsImageModel((prev) =>
      prev && imageNames.has(prev)
        ? prev
        : pickDefaultModel(imageModels, DEFAULT_IMAGE_MODEL_PREFERENCES)
    );
  }, [modelsLoading, textModels, imageModels]);

  const tabs: { id: TabId; label: string }[] = [
    { id: "text", label: "Text" },
    { id: "vision", label: "Vision" },
    { id: "image", label: "Image" },
    { id: "shorts", label: "Shorts" },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-b from-zinc-950 via-zinc-900 to-zinc-950 font-sans text-zinc-100">
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="mb-8 flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Ollama Playground
          </h1>
          <p className="max-w-xl text-zinc-400">
            Local chat, vision, and image generation through a small Node proxy.
            Start Ollama, run the API server, then use this UI.
          </p>
          {modelsError && (
            <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
              Models: {modelsError}
            </p>
          )}
        </div>

        <div className="mb-6 flex gap-1 rounded-xl bg-zinc-900/80 p-1 ring-1 ring-zinc-800">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-medium transition ${
                tab === t.id
                  ? "bg-zinc-800 text-white shadow"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-6 shadow-xl shadow-black/20 backdrop-blur-sm">
          {tab === "text" && (
            <ChatTab
              title="Text chat"
              description="Streaming assistant replies via /api/chat. Any chat-capable model, including vision models for text-only messages (image generation models are excluded)."
              model={modelByTab.text}
              models={textModels}
              onModelChange={(v) =>
                setModelByTab((s) => ({ ...s, text: v }))
              }
              modelsLoading={modelsLoading}
              allowImages={false}
            />
          )}
          {tab === "vision" && (
            <ChatTab
              title="Vision"
              description="Attach one or more images and ask questions. Only models with vision capability are listed."
              model={modelByTab.vision}
              models={visionModels}
              onModelChange={(v) =>
                setModelByTab((s) => ({ ...s, vision: v }))
              }
              modelsLoading={modelsLoading}
              allowImages={true}
            />
          )}
          {tab === "image" && (
            <ImageGenTab
              model={modelByTab.image}
              models={imageModels}
              onModelChange={(v) =>
                setModelByTab((s) => ({ ...s, image: v }))
              }
              modelsLoading={modelsLoading}
            />
          )}
          {tab === "shorts" && (
            <MovieShortsTab
              textModel={shortsTextModel}
              imageModel={shortsImageModel}
              textModels={textModels}
              imageModels={imageModels}
              onTextModelChange={setShortsTextModel}
              onImageModelChange={setShortsImageModel}
              modelsLoading={modelsLoading}
            />
          )}
        </div>
      </div>
    </div>
  );
}
