import type { OllamaModel } from "./api";

export function ModelSelect({
  models,
  value,
  onChange,
  disabled,
  label = "Model",
}: {
  models: OllamaModel[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="font-medium text-zinc-400">{label}</span>
      <select
        className="rounded-xl border border-zinc-700 bg-zinc-900/80 px-3 py-2.5 text-zinc-100 outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">Select a model…</option>
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
            {m.size != null
              ? ` (${(m.size / 1024 ** 3).toFixed(1)} GiB)`
              : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
