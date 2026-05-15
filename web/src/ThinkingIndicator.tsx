/** Inline “thinking” animation (CSS); avoids shipping a binary GIF while matching the same UX. */
export function ThinkingIndicator({
  label = "Thinking",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 py-1 text-zinc-400 ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="inline-flex items-center gap-1" aria-hidden>
        <span className="thinking-dot h-2 w-2 rounded-full bg-zinc-400" />
        <span className="thinking-dot h-2 w-2 rounded-full bg-zinc-400" />
        <span className="thinking-dot h-2 w-2 rounded-full bg-zinc-400" />
      </span>
      <span className="text-xs text-zinc-500">{label}…</span>
    </div>
  );
}
