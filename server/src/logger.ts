function stamp(): string {
  return new Date().toISOString();
}

export function log(line: string, meta?: Record<string, unknown>): void {
  if (meta && Object.keys(meta).length > 0) {
    console.log(`[${stamp()}] [api] ${line}`, meta);
  } else {
    console.log(`[${stamp()}] [api] ${line}`);
  }
}
