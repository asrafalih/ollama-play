function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("jpeg") || m === "image/jpg") return "jpg";
  if (m.includes("webp")) return "webp";
  return "png";
}

function slugify(s: string, maxLen: number): string {
  const out = s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/, "");
  return out || "image";
}

/** Client fallback when the API did not attach a name. */
export function buildImageDownloadFilename(
  model: string,
  prompt: string,
  mimeType: string,
  createdAt?: string
): string {
  const ext = extForMime(mimeType);
  const promptSlug = slugify(prompt.trim(), 72);
  const modelSlug = slugify(
    model.replace(/:latest$/i, "").replace(/\//g, "-"),
    36
  );
  const stamp =
    createdAt != null && createdAt.length > 0
      ? slugify(createdAt.replace(/[:.]/g, "-"), 32)
      : slugify(new Date().toISOString().replace(/[:.]/g, "-"), 32);
  let base = `${promptSlug}__${modelSlug}`;
  if (base.length > 110) base = base.slice(0, 110).replace(/-+$/, "");
  return `${base}__${stamp}.${ext}`;
}
