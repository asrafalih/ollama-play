import { log } from "./logger.js";

const PREVIEW_CHARS = 2_000;
const SUFFIX_CHARS = 800;

/**
 * Read Ollama response as text, log it (truncated — never dumps huge base64), then JSON.parse.
 */
export async function readOllamaJson<T = unknown>(
  r: Response,
  label: string
): Promise<T> {
  const text = await r.text();
  const len = text.length;
  const preview = text.slice(0, PREVIEW_CHARS);
  const suffix =
    len > PREVIEW_CHARS + SUFFIX_CHARS
      ? text.slice(-SUFFIX_CHARS)
      : undefined;

  log(`Ollama response [${label}]`, {
    httpStatus: r.status,
    ok: r.ok,
    contentType: r.headers.get("content-type"),
    bodyLength: len,
    bodyPreview: preview,
    ...(suffix != null ? { bodySuffix: suffix } : {}),
  });

  const trimmed = text.trim();
  if (!trimmed) {
    log(`Ollama empty body [${label}]`, { httpStatus: r.status });
    throw new SyntaxError(
      `Ollama returned an empty body for ${label} (expected JSON)`
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`Ollama JSON.parse failed [${label}]`, {
      error: msg,
      bodyLength: len,
      bodyPreview: preview,
      ...(suffix != null ? { bodySuffix: suffix } : {}),
    });
    throw e;
  }
}
