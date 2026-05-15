import type { OllamaModel } from "./api";

const VISION_NAME_PATTERN =
  /llava|moondream|minicpm-v|bakllava|internvl|pixtral|qwen2-vl|qwen3-vl|llama3\.2-vision|llama4|granite3\.2-vision|vision|[-_]vl[-_]?/i;

const IMAGE_NAME_PATTERN =
  /z-image|flux|sdxl|stable-diffusion|stable_diffusion|imagen|dreamshaper|animagine/i;

function hasCapabilitySet(caps: Set<string>, c: string): boolean {
  return caps.has(c);
}

/** When Ollama returns no capabilities, infer minimal tags from the model id (older daemons). */
function inferredCapabilitiesFromName(name: string): string[] {
  const n = name.toLowerCase();
  if (IMAGE_NAME_PATTERN.test(n)) return ["image"];
  if (VISION_NAME_PATTERN.test(n)) return ["vision", "completion"];
  return ["completion"];
}

function effectiveCapabilitySet(m: OllamaModel): Set<string> {
  const raw = m.capabilities?.filter((c) => typeof c === "string") ?? [];
  if (raw.length > 0) return new Set(raw);
  return new Set(inferredCapabilitiesFromName(m.name));
}

export function hasCapability(m: OllamaModel, c: string): boolean {
  return effectiveCapabilitySet(m).has(c);
}

/** Text chat: completion and not image generation; vision models are included (text-only use). */
export function filterTextModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter((m) => {
    const caps = effectiveCapabilitySet(m);
    if (!hasCapabilitySet(caps, "completion")) return false;
    if (hasCapabilitySet(caps, "image")) return false;
    if (hasCapabilitySet(caps, "embedding") && caps.size === 1) return false;
    return true;
  });
}

export function filterVisionModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter((m) => hasCapability(m, "vision"));
}

export function filterImageModels(models: OllamaModel[]): OllamaModel[] {
  return models.filter((m) => hasCapability(m, "image"));
}

function matchesPreferredName(modelName: string, base: string): boolean {
  return modelName === base || modelName.startsWith(`${base}:`);
}

/** First installed model matching a preferred base name, else first in list. */
export function pickDefaultModel(
  models: OllamaModel[],
  preferredBaseNames: string[]
): string {
  for (const base of preferredBaseNames) {
    const hit = models.find((m) => matchesPreferredName(m.name, base));
    if (hit) return hit.name;
  }
  return models[0]?.name ?? "";
}

export const DEFAULT_TEXT_MODEL_PREFERENCES = [
  "llama3.2",
  "llama3.1",
  "gemma3",
  "qwen2.5",
  "mistral",
  "phi3",
];

export const DEFAULT_VISION_MODEL_PREFERENCES = [
  "llama3.2-vision",
  "llava",
  "moondream",
  "minicpm-v",
  "gemma3",
  "qwen2-vl",
  "qwen2.5-vl",
];

export const DEFAULT_IMAGE_MODEL_PREFERENCES = [
  "z-image-turbo",
  "flux",
  "flux2",
  "sdxl",
];
