import { useCallback, useEffect, useRef, useState } from "react";
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
  | "prompts_ready"
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
  const [autoGenerateImages, setAutoGenerateImages] = useState(false);
  const [steps, setSteps] = useState<number | "">(20);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<SceneRow[]>([]);
  const [scenesPayload, setScenesPayload] = useState<ScenesPayload | null>(
    null
  );
  const [regenerateModalOpen, setRegenerateModalOpen] = useState(false);
  /** `null` = regenerate prompts for all scenes; number = that row index only */
  const [regenerateModalSceneIndex, setRegenerateModalSceneIndex] = useState<
    number | null
  >(null);
  const [regenerateModalStyles, setRegenerateModalStyles] = useState<string[]>(
    []
  );
  const [regenerateModalCustom, setRegenerateModalCustom] = useState("");
  const [regeneratePromptsBusy, setRegeneratePromptsBusy] = useState(false);
  const [soloSceneGenIndex, setSoloSceneGenIndex] = useState<number | null>(
    null
  );

  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const abortRef = useRef<AbortController | null>(null);
  const soloSceneAbortRef = useRef<AbortController | null>(null);
  const regenerateAbortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    soloSceneAbortRef.current?.abort();
    regenerateAbortRef.current?.abort();
  }, []);

  const toggleStyle = (id: string) => {
    setSelectedStyles((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleRegenerateModalStyle = (id: string) => {
    setRegenerateModalStyles((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const applyPreset = (w: number, h: number) => {
    setWidth(w);
    setHeight(h);
  };

  const generateImageForSceneIndex = useCallback(
    async (
      i: number,
      movieTitleForFile: string,
      prompt: string,
      signal: AbortSignal
    ): Promise<void> => {
      if (!prompt.trim()) {
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
        return;
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
        if (signal.aborted) return;
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
            `${movieTitleForFile}-scene-${i + 1}`,
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
        if (isAbortError(e)) return;
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
    },
    [imageModel, width, height, steps]
  );

  const openRegenerateModal = () => {
    setRegenerateModalSceneIndex(null);
    setRegenerateModalStyles([...selectedStyles]);
    setRegenerateModalCustom(customStyle);
    setRegenerateModalOpen(true);
  };

  const openRegenerateScenePromptModal = (sceneRowIndex: number) => {
    setRegenerateModalSceneIndex(sceneRowIndex);
    setRegenerateModalStyles([...selectedStyles]);
    setRegenerateModalCustom(customStyle);
    setRegenerateModalOpen(true);
  };

  const closeRegenerateModal = () => {
    if (regeneratePromptsBusy) return;
    setRegenerateModalOpen(false);
    setRegenerateModalSceneIndex(null);
  };

  const confirmRegeneratePrompts = async () => {
    if (!scenesPayload || !textModel || regenerateModalStyles.length === 0) {
      return;
    }
    setError(null);
    setRegeneratePromptsBusy(true);
    const ctrl = new AbortController();
    regenerateAbortRef.current = ctrl;
    const { signal } = ctrl;
    const targetIdx = regenerateModalSceneIndex;
    try {
      if (targetIdx === null) {
        const n = scenesPayload.scenes.length;
        const promptsRaw = await streamChatCollectText(
          textModel,
          buildImagePromptsMessages(
            scenesPayload,
            regenerateModalStyles,
            regenerateModalCustom.trim() || undefined,
            width,
            height
          ),
          { signal, format: "json" }
        );
        if (signal.aborted) return;
        const parsedPrompts = parseImagePromptsJson(promptsRaw, n);
        const promptByIndex = new Map(
          parsedPrompts.scenes.map((s) => [s.index, s.imagePrompt])
        );
        setRows((prev) =>
          prev.map((r, i) => ({
            ...r,
            imagePrompt: promptByIndex.get(i + 1) ?? r.imagePrompt,
            imageBase64: undefined,
            mimeType: undefined,
            downloadFilename: undefined,
            imageError: undefined,
            imageGenStatus: undefined,
            imageGenProgress: undefined,
          }))
        );
      } else {
        const row = rowsRef.current[targetIdx];
        if (!row) return;
        // Single-scene request must use index 1 in JSON so the model returns
        // {"scenes":[{"index":1,...}]} matching parseImagePromptsJson(raw, 1).
        const singlePayload: ScenesPayload = {
          movieTitle: scenesPayload.movieTitle,
          scenes: [{ ...row.scene, index: 1 }],
        };
        const promptsRaw = await streamChatCollectText(
          textModel,
          buildImagePromptsMessages(
            singlePayload,
            regenerateModalStyles,
            regenerateModalCustom.trim() || undefined,
            width,
            height
          ),
          { signal, format: "json" }
        );
        if (signal.aborted) return;
        const parsedPrompts = parseImagePromptsJson(promptsRaw, 1);
        const newPrompt = parsedPrompts.scenes[0]?.imagePrompt;
        setRows((prev) =>
          prev.map((r, i) =>
            i === targetIdx
              ? {
                  ...r,
                  imagePrompt: newPrompt ?? r.imagePrompt,
                  imageBase64: undefined,
                  mimeType: undefined,
                  downloadFilename: undefined,
                  imageError: undefined,
                  imageGenStatus: undefined,
                  imageGenProgress: undefined,
                }
              : r
          )
        );
      }
      setRegenerateModalOpen(false);
      setRegenerateModalSceneIndex(null);
    } catch (e) {
      if (!isAbortError(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (regenerateAbortRef.current === ctrl) {
        regenerateAbortRef.current = null;
      }
      setRegeneratePromptsBusy(false);
    }
  };

  const handleGenerateSceneImage = async (i: number) => {
    if (!imageModel || !scenesPayload || soloSceneGenIndex !== null) return;
    const prompt = rowsRef.current[i]?.imagePrompt?.trim();
    if (!prompt) return;

    soloSceneAbortRef.current?.abort();
    const ctrl = new AbortController();
    soloSceneAbortRef.current = ctrl;
    const { signal } = ctrl;
    setSoloSceneGenIndex(i);
    try {
      await generateImageForSceneIndex(
        i,
        scenesPayload.movieTitle,
        prompt,
        signal
      );
    } finally {
      if (soloSceneAbortRef.current === ctrl) {
        soloSceneAbortRef.current = null;
      }
      setSoloSceneGenIndex(null);
    }
  };

  const run = async () => {
    const title = movieTitle.trim();
    const n = Math.min(MAX_SCENES, Math.max(1, Math.floor(sceneCount)));
    if (!title || !textModel) return;
    if (autoGenerateImages && !imageModel) return;

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
          ...(autoGenerateImages
            ? { imageGenStatus: "pending" as const, imageGenProgress: null }
            : {}),
        }))
      );

      if (!autoGenerateImages) {
        if (signal.aborted) {
          setPhase("idle");
          return;
        }
        setPhase("prompts_ready");
        return;
      }

      setPhase("images");
      for (let i = 0; i < parsedScenes.scenes.length; i++) {
        if (signal.aborted) {
          setPhase("idle");
          return;
        }
        const prompt = promptByIndex.get(i + 1) ?? "";
        if (!prompt.trim()) {
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
        await generateImageForSceneIndex(
          i,
          parsedScenes.movieTitle,
          prompt,
          signal
        );
        if (signal.aborted) {
          setPhase("idle");
          return;
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

  const busy =
    phase === "scenes" ||
    phase === "prompts" ||
    phase === "images" ||
    regeneratePromptsBusy;
  const soloSceneBusy = soloSceneGenIndex !== null;
  const stopEnabled = busy || soloSceneBusy;

  const hasImagePrompts = rows.some((r) => Boolean(r.imagePrompt?.trim()));

  const voiceoverAll = rows
    .map(
      (r, i) =>
        `Scene ${i + 1} — ${r.scene.title}\n${r.scene.voiceOver.trim()}\n`
    )
    .join("\n");

  const pipelineDisabled =
    busy ||
    soloSceneBusy ||
    !movieTitle.trim() ||
    !textModel ||
    (autoGenerateImages && !imageModel) ||
    selectedStyles.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h2 className="text-lg font-semibold text-zinc-100">
          Movie Shorts generator
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          Builds scene beats and voice-over with your text model, crafts image
          prompts from your style choices, then optionally renders each frame
          with your image model — vertical Shorts default{" "}
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
          label={
            autoGenerateImages
              ? "Image model"
              : "Image model (for rendering images)"
          }
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

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-3 text-sm text-zinc-300">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-600 bg-zinc-900"
          checked={autoGenerateImages}
          onChange={(e) => setAutoGenerateImages(e.target.checked)}
        />
        <span>
          <span className="font-medium text-zinc-200">
            Automatically generate images for all scenes
          </span>
          <span className="mt-0.5 block text-xs text-zinc-500">
            When off, image prompts are still created; use{" "}
            <span className="text-zinc-400">Generate image</span> on each scene
            after choosing an image model.
          </span>
        </span>
      </label>

      {error && (
        <p className="rounded-lg border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pipelineDisabled}
          onClick={() => void run()}
          className="flex min-h-[2.75rem] min-w-[8rem] items-center justify-center rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate pipeline
        </button>
        <button
          type="button"
          disabled={!stopEnabled}
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
            {phase === "prompts_ready" &&
              "Image prompts ready — render per scene or enable auto images and run again."}
            {phase === "done" && "Done."}
          </span>
        )}
        {regeneratePromptsBusy && (
          <span className="text-xs text-zinc-500">
            {regenerateModalSceneIndex === null
              ? "Regenerating image prompts…"
              : `Regenerating scene ${regenerateModalSceneIndex + 1} prompt…`}
          </span>
        )}
      </div>

      {(phase === "scenes" || phase === "prompts") && (
        <ThinkingIndicator
          label={phase === "scenes" ? "Writing scenes" : "Writing prompts"}
          className="text-zinc-500"
        />
      )}

      {regeneratePromptsBusy && (
        <ThinkingIndicator
          label={
            regenerateModalSceneIndex === null
              ? "Regenerating image prompts"
              : `Regenerating scene ${regenerateModalSceneIndex + 1} image prompt`
          }
          className="text-zinc-500"
        />
      )}

      {scenesPayload && hasImagePrompts && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={
              busy ||
              soloSceneBusy ||
              !textModel ||
              regeneratePromptsBusy
            }
            onClick={openRegenerateModal}
            className="rounded-lg border border-violet-600/70 bg-violet-950/50 px-4 py-2 text-sm font-medium text-violet-100 hover:bg-violet-900/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Regenerate all image prompts…
          </button>
        </div>
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
              phase={phase}
              autoGenerateImages={autoGenerateImages}
              soloSceneBusy={soloSceneBusy}
              soloSceneGenIndex={soloSceneGenIndex}
              scenePromptRegenBusy={
                regeneratePromptsBusy && regenerateModalSceneIndex === i
              }
              regeneratePromptsBusy={regeneratePromptsBusy}
              onGenerateImage={() => void handleGenerateSceneImage(i)}
              onRegenerateImagePrompt={() => openRegenerateScenePromptModal(i)}
              regenerateImagePromptDisabled={
                busy ||
                soloSceneBusy ||
                regeneratePromptsBusy ||
                !textModel ||
                !Boolean(row.imagePrompt?.trim())
              }
            />
          ))}
        </div>
      )}

      {regenerateModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              closeRegenerateModal();
            }
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-zinc-700 bg-zinc-950 p-5 shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="regen-prompts-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="regen-prompts-title"
              className="text-base font-semibold text-zinc-100"
            >
              {regenerateModalSceneIndex === null
                ? "Regenerate all image prompts"
                : `Regenerate image prompt — Scene ${regenerateModalSceneIndex + 1}`}
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Choose styles for this regeneration.{" "}
              {regenerateModalSceneIndex === null
                ? "Existing rendered images for every scene will be cleared when new prompts arrive."
                : "The rendered image for this scene only will be cleared when the new prompt arrives."}
            </p>

            <div className="mt-4">
              <span className="mb-2 block text-sm font-medium text-zinc-400">
                Image styles
              </span>
              <div className="flex flex-wrap gap-2">
                {IMAGE_STYLE_PRESETS.map((p) => (
                  <label
                    key={p.id}
                    className={`cursor-pointer rounded-lg border px-3 py-2 text-xs transition ${
                      regenerateModalStyles.includes(p.id)
                        ? "border-violet-500 bg-violet-950/50 text-violet-100"
                        : "border-zinc-600 bg-zinc-900/50 text-zinc-400 hover:border-zinc-500"
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={regenerateModalStyles.includes(p.id)}
                      onChange={() => toggleRegenerateModalStyle(p.id)}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>

            <label className="mt-4 flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-zinc-400">
                Custom style (optional)
              </span>
              <input
                type="text"
                className="rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                value={regenerateModalCustom}
                onChange={(e) => setRegenerateModalCustom(e.target.value)}
                placeholder="e.g. golden hour"
                disabled={regeneratePromptsBusy}
              />
            </label>

            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                disabled={regeneratePromptsBusy}
                onClick={closeRegenerateModal}
                className="rounded-lg border border-zinc-600 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800/80 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  regeneratePromptsBusy ||
                  regenerateModalStyles.length === 0 ||
                  !textModel
                }
                onClick={() => void confirmRegeneratePrompts()}
                className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {regeneratePromptsBusy ? "Working…" : "Regenerate"}
              </button>
            </div>
          </div>
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
  phase,
  autoGenerateImages,
  soloSceneBusy,
  soloSceneGenIndex,
  scenePromptRegenBusy,
  regeneratePromptsBusy,
  onGenerateImage,
  onRegenerateImagePrompt,
  regenerateImagePromptDisabled,
}: {
  index: number;
  row: SceneRow;
  imageModel: string;
  phase: Phase;
  autoGenerateImages: boolean;
  soloSceneBusy: boolean;
  soloSceneGenIndex: number | null;
  scenePromptRegenBusy: boolean;
  regeneratePromptsBusy: boolean;
  onGenerateImage: () => void;
  onRegenerateImagePrompt: () => void;
  regenerateImagePromptDisabled: boolean;
}) {
  const s: SceneFromLlm = row.scene;
  const st = row.imageGenStatus;
  const showPerSceneImageProgress =
    (phase === "images" ||
      phase === "done" ||
      phase === "error" ||
      phase === "prompts_ready") &&
    st != null &&
    !(phase === "prompts_ready" && st === "pending");

  const autoBulkImagePass = autoGenerateImages && phase === "images";
  const showGenerateImageButton =
    Boolean(row.imagePrompt?.trim()) &&
    Boolean(imageModel) &&
    !autoBulkImagePass;

  const hasImagePromptForActions = Boolean(row.imagePrompt?.trim());

  const thisSceneBusy = soloSceneGenIndex === index;
  const generateDisabled =
    soloSceneBusy ||
    regeneratePromptsBusy ||
    !imageModel ||
    !row.imagePrompt?.trim();

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
      <div className="mb-2 text-sm font-medium text-sky-300">
        Scene {index + 1}: {s.title}
      </div>
      {showPerSceneImageProgress && st != null && (
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
      {(hasImagePromptForActions || showGenerateImageButton) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {hasImagePromptForActions && (
            <button
              type="button"
              disabled={regenerateImagePromptDisabled}
              onClick={onRegenerateImagePrompt}
              className="rounded-lg border border-violet-600/70 bg-violet-950/50 px-3 py-1.5 text-xs font-medium text-violet-100 hover:bg-violet-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {scenePromptRegenBusy
                ? "Working…"
                : "Regenerate image prompt…"}
            </button>
          )}
          {showGenerateImageButton && (
            <button
              type="button"
              disabled={generateDisabled}
              onClick={onGenerateImage}
              className="rounded-lg border border-sky-600/70 bg-sky-950/50 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-900/60 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {thisSceneBusy ? "Generating…" : "Generate image"}
            </button>
          )}
        </div>
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
