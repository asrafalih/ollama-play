import { useCallback, useRef, useState } from "react";
import type { OllamaModel } from "./api";
import { streamChatCollectText, streamGenerate } from "./api";
import { buildImageDownloadFilename } from "./imageDownloadFilename";
import {
  buildImagePromptsMessages,
  buildScenesMessages,
  IMAGE_STYLE_PRESETS,
  parseImagePromptsJson,
  parseScenesJson,
  type SceneFromLlm,
  type ScenesPayload,
} from "./movieShortsPrompts";
import { ModelSelect } from "./ModelSelect";
import { ThinkingIndicator } from "./ThinkingIndicator";

const DEFAULT_W = 720;
const DEFAULT_H = 1280;
const MAX_SCENES = 12;

type Phase =
  | "idle"
  | "scenes"
  | "prompts"
  | "images"
  | "done"
  | "error";

export type SceneRow = {
  scene: SceneFromLlm;
  imagePrompt?: string;
  imageBase64?: string;
  mimeType?: string;
  downloadFilename?: string;
  imageError?: string;
  /** Per-scene image pipeline UI */
  imageGenStatus?: "pending" | "active" | "done" | "skipped" | "error";
  imageGenProgress?: { completed: number; total: number } | null;
};

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

function downloadTextFile(filename: string, text: string) {
  const a = document.createElement("a");
  a.href = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  a.download = filename;
  a.click();
}

export function MovieShortsTab({
  textModel,
  imageModel,
  textModels,
  imageModels,
  onTextModelChange,
  onImageModelChange,
  modelsLoading,
}: {
  textModel: string;
  imageModel: string;
  textModels: OllamaModel[];
  imageModels: OllamaModel[];
  onTextModelChange: (v: string) => void;
  onImageModelChange: (v: string) => void;
  modelsLoading: boolean;
}) {
  const [movieTitle, setMovieTitle] = useState("");
  const [sceneCount, setSceneCount] = useState(5);
  const [width, setWidth] = useState(DEFAULT_W);
  const [height, setHeight] = useState(DEFAULT_H);
  const [selectedStyles, setSelectedStyles] = useState<string[]>(["cinematic"]);
  const [customStyle, setCustomStyle] = useState("");
  const [steps, setSteps] = useState<number | "">(20);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SceneRow[]>([]);
  const [scenesPayload, setScenesPayload] = useState<ScenesPayload | null>(
    null
  );
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const toggleStyle = (id: string) => {
    setSelectedStyles((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const applyPreset = (w: number, h: number) => {
    setWidth(w);
    setHeight(h);
  };

  const run = async () => {
    const title = movieTitle.trim();
    const n = Math.min(MAX_SCENES, Math.max(1, Math.floor(sceneCount)));
    if (!title || !textModel || !imageModel) return;

    setError(null);
    setRows([]);
    setScenesPayload(null);
    setPhase("scenes");
    abortRef.current = new AbortController();
    const { signal } = abortRef.current;

    try {
      const scenesRaw = await streamChatCollectText(
        textModel,
        buildScenesMessages(title, n),
        { signal, format: "json" }
      );
      if (signal.aborted) {
        setPhase("idle");
        return;
      }
      const parsedScenes = parseScenesJson(scenesRaw, n);
      setScenesPayload(parsedScenes);
      setRows(
        parsedScenes.scenes.map((scene) => ({
          scene,
        }))
      );

      setPhase("prompts");
      const promptsRaw = await streamChatCollectText(
        textModel,
        buildImagePromptsMessages(
          parsedScenes,
          selectedStyles,
          customStyle || undefined,
          width,
          height
        ),
        { signal, format: "json" }
      );
      if (signal.aborted) {
        setPhase("idle");
        return;
      }
      const parsedPrompts = parseImagePromptsJson(promptsRaw, n);
      const promptByIndex = new Map(
        parsedPrompts.scenes.map((s) => [s.index, s.imagePrompt])
      );
      setRows((prev) =>
        prev.map((r, i) => ({
          ...r,
          imagePrompt: promptByIndex.get(i + 1) ?? r.imagePrompt,
          imageGenStatus: "pending",
          imageGenProgress: null,
        }))
      );

      setPhase("images");
      for (let i = 0; i < parsedScenes.scenes.length; i++) {
        if (signal.aborted) {
          setPhase("idle");
          return;
        }
        const prompt = promptByIndex.get(i + 1);
        if (!prompt?.trim()) {
          setRows((prev) => {
            const copy = [...prev];
            if (copy[i]) {
              copy[i] = {
                ...copy[i],
                imageError: "Missing image prompt for this scene.",
                imageGenStatus: "skipped",
                imageGenProgress: null,
              };
            }
            return copy;
          });
          continue;
        }
        setRows((prev) =>
          prev.map((r, j) =>
            j === i
              ? {
                  ...r,
                  imageGenStatus: "active",
                  imageGenProgress: { completed: 0, total: 1 },
                }
              : r
          )
        );
        try {
          const data = await streamGenerate({
            model: imageModel,
            prompt: prompt.trim(),
            width,
            height,
            steps: steps === "" ? undefined : steps,
            onProgress: (completed, total) =>
              setRows((prev) => {
                const copy = [...prev];
                const cur = copy[i];
                if (cur) {
                  copy[i] = {
                    ...cur,
                    imageGenProgress: { completed, total },
                  };
                }
                return copy;
              }),
            signal,
          });
          if (signal.aborted) {
            setPhase("idle");
            return;
          }
          const b64 = data.imageBase64;
          const mime = data.mimeType ?? "image/png";
          if (!b64) {
            throw new Error(
              data.error ||
                data.response?.slice(0, 200) ||
                "No image returned for this scene."
            );
          }
          const downloadFilename =
            data.downloadFilename?.trim() ||
            buildImageDownloadFilename(
              imageModel,
              `${parsedScenes.movieTitle}-scene-${i + 1}`,
              mime
            );
          setRows((prev) => {
            const copy = [...prev];
            if (copy[i]) {
              copy[i] = {
                ...copy[i],
                imageBase64: b64,
                mimeType: mime,
                downloadFilename,
                imageError: undefined,
                imageGenStatus: "done",
                imageGenProgress: null,
              };
            }
            return copy;
          });
        } catch (e) {
          if (isAbortError(e)) {
            setPhase("idle");
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          setRows((prev) => {
            const copy = [...prev];
            if (copy[i]) {
              copy[i] = {
                ...copy[i],
                imageError: msg,
                imageGenStatus: "error",
                imageGenProgress: null,
              };
            }
            return copy;
          });
        }
      }

      if (signal.aborted) {
        setPhase("idle");
        return;
      }

      setPhase("done");
    } catch (e) {
      if (isAbortError(e)) {
        setPhase("idle");
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  };

  const busy = phase === "scenes" || phase === "prompts" || phase === "images";
  const voiceoverAll = rows
    .map(
      (r, i) =>
        `Scene ${i + 1} — ${r.scene.title}\n${r.scene.voiceOver.trim()}\n`
    )
    .join("\n");

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold text-zinc-100">
          Movie Shorts generator
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Builds scene beats and voice-over with your text model, crafts image
          prompts from your style choices, then renders each frame with your
          image model — vertical Shorts default{" "}
          <span className="text-zinc-400">
            {DEFAULT_W}×{DEFAULT_H}
          </span>{" "}
          (9:16). Heavier sizes (e.g. 1080×1920) can fail to return pixels for some
          local models such as{" "}
          <code className="text-zinc-400">x/z-image-turbo</code> over the API.
        </p>
        <p className="mt-2 text-xs text-zinc-600">
          Outputs are model-generated and may be inaccurate; you are responsible
          for how you use them on YouTube (copyright, originality, and community
          guidelines).
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <ModelSelect
          label="Text model"
          models={textModels}
          value={textModel}
          onChange={onTextModelChange}
          disabled={modelsLoading}
        />
        <ModelSelect
          label="Image model"
          models={imageModels}
          value={imageModel}
          onChange={onImageModelChange}
          disabled={modelsLoading}
        />
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-zinc-400">Movie title</span>
        <input
          type="text"
          className="rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2.5 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
          value={movieTitle}
          onChange={(e) => setMovieTitle(e.target.value)}
          placeholder="e.g. Inception"
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Number of scenes (1–{MAX_SCENES})</span>
          <input
            type="number"
            min={1}
            max={MAX_SCENES}
            className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
            value={sceneCount}
            onChange={(e) => setSceneCount(Number(e.target.value))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-400">Steps (image)</span>
          <input
            type="number"
            min={1}
            className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
            value={steps}
            onChange={(e) =>
              setSteps(e.target.value === "" ? "" : Number(e.target.value))
            }
          />
        </label>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-zinc-400">
          Resolution
        </span>
        <div className="mb-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-emerald-700/60 bg-emerald-950/40 px-3 py-1.5 text-xs text-emerald-100 hover:border-emerald-500"
            onClick={() => applyPreset(720, 1280)}
          >
            Shorts 720×1280 (default)
          </button>
          <button
            type="button"
            className="rounded-lg border border-zinc-600 bg-zinc-800/80 px-3 py-1.5 text-xs text-zinc-200 hover:border-sky-600"
            onClick={() => applyPreset(1080, 1920)}
          >
            Shorts 1080×1920
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Width</span>
            <input
              type="number"
              min={64}
              className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-400">Height</span>
            <input
              type="number"
              min={64}
              className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-2 py-2 text-zinc-100"
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      <div>
        <span className="mb-2 block text-sm font-medium text-zinc-400">
          Image styles (multi-select)
        </span>
        <div className="flex flex-wrap gap-2">
          {IMAGE_STYLE_PRESETS.map((p) => (
            <label
              key={p.id}
              className={`cursor-pointer rounded-lg border px-3 py-2 text-xs transition ${
                selectedStyles.includes(p.id)
                  ? "border-violet-500 bg-violet-950/50 text-violet-100"
                  : "border-zinc-600 bg-zinc-900/50 text-zinc-400 hover:border-zinc-500"
              }`}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={selectedStyles.includes(p.id)}
                onChange={() => toggleStyle(p.id)}
              />
              {p.label}
            </label>
          ))}
        </div>
      </div>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-zinc-400">Custom style (optional)</span>
        <input
          type="text"
          className="rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
          value={customStyle}
          onChange={(e) => setCustomStyle(e.target.value)}
          placeholder="e.g. golden hour, teal and orange grade"
        />
      </label>

      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={
            busy ||
            !movieTitle.trim() ||
            !textModel ||
            !imageModel ||
            selectedStyles.length === 0
          }
          onClick={() => void run()}
          className="flex min-h-[2.75rem] min-w-[8rem] items-center justify-center rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate pipeline
        </button>
        <button
          type="button"
          disabled={!busy}
          onClick={stop}
          className="rounded-xl border border-amber-600/70 bg-amber-950/80 px-4 py-2.5 text-sm font-medium text-amber-100 hover:bg-amber-900/90 disabled:opacity-40"
        >
          Stop
        </button>
        {phase !== "idle" && phase !== "error" && (
          <span className="text-xs text-zinc-500">
            {phase === "scenes" && "Generating scenes + voice-over…"}
            {phase === "prompts" && "Generating image prompts…"}
            {phase === "images" && "Rendering images…"}
            {phase === "done" && "Done."}
          </span>
        )}
      </div>

      {(phase === "scenes" || phase === "prompts") && (
        <ThinkingIndicator
          label={phase === "scenes" ? "Writing scenes" : "Writing prompts"}
          className="text-zinc-500"
        />
      )}

      {scenesPayload && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-zinc-200">
              Voice-over (all scenes)
            </h3>
            <button
              type="button"
              className="text-xs text-sky-400 underline"
              onClick={() =>
                downloadTextFile(
                  `${scenesPayload.movieTitle.replace(/[^\w\s-]/g, "").slice(0, 60) || "shorts"}-voiceover.txt`,
                  `${scenesPayload.movieTitle}\n\n${voiceoverAll}`
                )
              }
            >
              Download .txt
            </button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-zinc-400">
            {voiceoverAll || "(run generate)"}
          </pre>
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-zinc-300">Scenes</h3>
          {rows.map((row, i) => (
            <SceneCard
              key={i}
              index={i}
              row={row}
              imageModel={imageModel}
              showPerSceneImageProgress={
                phase === "images" || phase === "done" || phase === "error"
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SceneImageGenBar({ row }: { row: SceneRow }) {
  const st = row.imageGenStatus;
  if (st == null) return null;

  if (st === "skipped") {
    return (
      <p className="text-[11px] text-zinc-500">Image: skipped (no prompt)</p>
    );
  }

  if (st === "done" && row.imageBase64) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-emerald-500/90">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
          aria-hidden
        />
        Image rendered
      </div>
    );
  }

  if (st === "done") {
    return null;
  }

  if (st === "error") {
    return (
      <p className="text-[11px] text-red-400/90">Image generation failed</p>
    );
  }

  const pg = row.imageGenProgress;
  const pct =
    pg != null && pg.total > 0
      ? Math.min(100, (100 * pg.completed) / pg.total)
      : 0;
  const labelRight =
    st === "pending"
      ? "Queued"
      : pg != null && pg.total > 0
        ? `${pg.completed} / ${pg.total}`
        : "Starting…";

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-zinc-500">
        <span>Image generation</span>
        <span>{labelRight}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            st === "pending" ? "bg-zinc-600" : "bg-violet-500"
          }`}
          style={{ width: `${st === "pending" ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

function SceneCard({
  index,
  row,
  imageModel,
  showPerSceneImageProgress,
}: {
  index: number;
  row: SceneRow;
  imageModel: string;
  showPerSceneImageProgress: boolean;
}) {
  const s: SceneFromLlm = row.scene;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="mb-2 text-sm font-medium text-sky-300">
        Scene {index + 1}: {s.title}
      </div>
      {showPerSceneImageProgress && row.imageGenStatus != null && (
        <div className="mb-3 rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-3 py-2">
          <SceneImageGenBar row={row} />
        </div>
      )}
      <p className="mb-2 text-xs text-zinc-500">
        <span className="font-semibold text-zinc-400">Script: </span>
        {s.script}
      </p>
      <p className="mb-2 text-xs text-zinc-500">
        <span className="font-semibold text-zinc-400">Voice-over: </span>
        {s.voiceOver}
      </p>
      {row.imagePrompt && (
        <p className="mb-2 text-xs text-zinc-600">
          <span className="font-semibold text-zinc-500">Image prompt: </span>
          {row.imagePrompt}
        </p>
      )}
      {row.imageError && (
        <p className="text-xs text-red-400">{row.imageError}</p>
      )}
      {row.imageBase64 && row.mimeType && (
        <div className="mt-3 space-y-2">
          <img
            src={`data:${row.mimeType};base64,${row.imageBase64}`}
            alt=""
            className="max-h-[420px] w-auto max-w-full rounded-lg ring-1 ring-zinc-700"
          />
          <button
            type="button"
            className="text-sm text-sky-400 underline"
            onClick={() =>
              downloadBase64(
                row.imageBase64!,
                row.mimeType!,
                row.downloadFilename ||
                  buildImageDownloadFilename(
                    imageModel,
                    `scene-${index + 1}`,
                    row.mimeType!
                  )
              )
            }
          >
            Download image
          </button>
        </div>
      )}
    </div>
  );
}
