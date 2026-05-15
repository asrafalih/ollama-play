import type { ChatMessage } from "./api";

export const IMAGE_STYLE_PRESETS = [
  { id: "cinematic", label: "Cinematic photorealistic", hint: "cinematic lighting, film grain, shallow depth of field, highly detailed photorealistic" },
  { id: "anime", label: "Anime", hint: "anime style, clean line art, vibrant colors, studio quality" },
  { id: "watercolor", label: "Watercolor", hint: "soft watercolor painting, paper texture, gentle washes" },
  { id: "noir", label: "Film noir", hint: "high contrast black and white, dramatic shadows, noir atmosphere" },
  { id: "pixar3d", label: "3D animation (Pixar-like)", hint: "stylized 3D render, expressive characters, soft global illumination" },
  { id: "comic", label: "Comic book", hint: "bold ink lines, halftone dots, dynamic comic panel aesthetic" },
] as const;

export type SceneFromLlm = {
  index: number;
  title: string;
  script: string;
  voiceOver: string;
};

export type ScenesPayload = {
  movieTitle: string;
  scenes: SceneFromLlm[];
};

export type ImagePromptScene = {
  index: number;
  imagePrompt: string;
};

export type ImagePromptsPayload = {
  scenes: ImagePromptScene[];
};

export function stripJsonFence(raw: string): string {
  const t = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/im.exec(t);
  if (fence) return fence[1].trim();
  return t;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function expectString(x: unknown, field: string): string {
  if (typeof x === "string" && x.trim().length > 0) return x.trim();
  throw new Error(`Invalid or missing string field: ${field}`);
}

function expectNumber(x: unknown, field: string): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x)) return Number(x);
  throw new Error(`Invalid number field: ${field}`);
}

export function parseScenesJson(
  raw: string,
  expectedCount: number
): ScenesPayload {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error(
      "Could not parse scene JSON. Try again, or upgrade Ollama for JSON mode support."
    );
  }
  if (!isRecord(data)) throw new Error("Scene response must be a JSON object.");
  const movieTitle = expectString(data.movieTitle, "movieTitle");
  const scenesRaw = data.scenes;
  if (!Array.isArray(scenesRaw)) {
    throw new Error('Scene response must include a "scenes" array.');
  }
  if (scenesRaw.length !== expectedCount) {
    throw new Error(
      `Expected exactly ${expectedCount} scenes, got ${scenesRaw.length}.`
    );
  }
  const scenes: SceneFromLlm[] = scenesRaw.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`Scene ${i + 1} must be an object.`);
    }
    return {
      index: expectNumber(item.index, `scenes[${i}].index`),
      title: expectString(item.title, `scenes[${i}].title`),
      script: expectString(item.script, `scenes[${i}].script`),
      voiceOver: expectString(item.voiceOver, `scenes[${i}].voiceOver`),
    };
  });
  const indices = scenes.map((s) => s.index).sort((a, b) => a - b);
  for (let k = 0; k < indices.length; k++) {
    if (indices[k] !== k + 1) {
      throw new Error(
        `Scene indices must be 1..${expectedCount} once each; got ${indices.join(", ")}.`
      );
    }
  }
  return { movieTitle, scenes };
}

export function parseImagePromptsJson(
  raw: string,
  expectedCount: number
): ImagePromptsPayload {
  let data: unknown;
  try {
    data = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error(
      "Could not parse image-prompt JSON. Try again or check the text model output."
    );
  }
  if (!isRecord(data)) throw new Error("Image prompt response must be a JSON object.");
  const scenesRaw = data.scenes;
  if (!Array.isArray(scenesRaw)) {
    throw new Error('Image prompt response must include a "scenes" array.');
  }
  if (scenesRaw.length !== expectedCount) {
    throw new Error(
      `Expected ${expectedCount} image prompts, got ${scenesRaw.length}.`
    );
  }
  const scenes: ImagePromptScene[] = scenesRaw.map((item, i) => {
    if (!isRecord(item)) {
      throw new Error(`Image prompt ${i + 1} must be an object.`);
    }
    return {
      index: expectNumber(item.index, `scenes[${i}].index`),
      imagePrompt: expectString(item.imagePrompt, `scenes[${i}].imagePrompt`),
    };
  });
  const indices = scenes.map((s) => s.index).sort((a, b) => a - b);
  for (let k = 0; k < indices.length; k++) {
    if (indices[k] !== k + 1) {
      throw new Error(
        `Image prompt indices must be 1..${expectedCount} once each; got ${indices.join(", ")}.`
      );
    }
  }
  return { scenes };
}

const SCENES_SYSTEM = `You are a creative assistant for short-form vertical video (YouTube Shorts).
Given a movie title and a scene count, you output memorable, high-level scene beats inspired by public knowledge of the film — not long verbatim dialogue or screenplay excerpts.
Each scene needs a short script beat (what we see) and a separate voice-over line suitable for text-to-speech (concise, 1–3 sentences, engaging for Shorts).
Respond with JSON only (no markdown fences, no commentary).`;

export function buildScenesUserPrompt(movieTitle: string, sceneCount: number): string {
  return `Movie title: "${movieTitle}"
Number of scenes: ${sceneCount}

Return this exact JSON shape:
{"movieTitle":string,"scenes":[{"index":1,"title":string,"script":string,"voiceOver":string},...]}

Rules:
- "movieTitle" should echo the given title (string).
- "scenes" must have exactly ${sceneCount} items.
- "index" must be 1 through ${sceneCount} in order.
- "title": short scene heading (few words).
- "script": 2–4 sentences describing the visual beat (no copyrighted dialogue).
- "voiceOver": narration the creator can read for TTS (natural, second person or neutral narrator OK).`;

}

const IMAGE_PROMPTS_SYSTEM = `You write detailed English prompts for text-to-image models.
Output JSON only (no markdown, no extra text).`;

export function buildImagePromptsUserPrompt(
  scenes: ScenesPayload,
  styleHints: string[],
  customStyle: string | undefined,
  width: number,
  height: number
): string {
  const styleBlock =
    styleHints.length > 0
      ? styleHints.join("; ")
      : "general high quality";
  const custom =
    customStyle?.trim() ? ` Additional style notes: ${customStyle.trim()}` : "";

  return `You are given scenes for a vertical ${width}x${height} (${width < height ? "9:16 portrait" : "image"}) frame.

Visual style to apply: ${styleBlock}.${custom}

Composition: vertical 9:16, important subject centered, leave clean margins top/bottom for optional text overlay.

Scenes JSON (use only this content to infer visuals; do not add new plot beats):
${JSON.stringify(scenes, null, 2)}

Return exactly:
{"scenes":[{"index":1,"imagePrompt":string},...]}

Rules:
- Same number of scenes as input; indices 1..N in order.
- Each "imagePrompt": one rich paragraph suitable for an image model; include lighting, camera, mood, and the style hints; no JSON inside strings.`;

}

export function buildScenesMessages(
  movieTitle: string,
  sceneCount: number
): ChatMessage[] {
  return [
    { role: "system", content: SCENES_SYSTEM },
    { role: "user", content: buildScenesUserPrompt(movieTitle, sceneCount) },
  ];
}

export function buildImagePromptsMessages(
  scenes: ScenesPayload,
  selectedPresetIds: string[],
  customStyle: string | undefined,
  width: number,
  height: number
): ChatMessage[] {
  const hints = IMAGE_STYLE_PRESETS.filter((p) =>
    selectedPresetIds.includes(p.id)
  ).map((p) => p.hint);
  return [
    { role: "system", content: IMAGE_PROMPTS_SYSTEM },
    {
      role: "user",
      content: buildImagePromptsUserPrompt(scenes, hints, customStyle, width, height),
    },
  ];
}
