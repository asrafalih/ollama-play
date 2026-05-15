/** Strip data-URL prefix so Ollama receives raw base64. */
export function stripDataUrlBase64(input: string): string {
  const m = /^data:[^;]+;base64,(.+)$/s.exec(input.trim());
  return m ? m[1]! : input;
}
