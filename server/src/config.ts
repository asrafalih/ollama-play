function normalizeOllamaHost(url: string): string {
  return url.replace(/\/$/, "");
}

export const OLLAMA_HOST = normalizeOllamaHost(
  process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434"
);

export const PORT = Number(process.env.PORT) || 3001;
