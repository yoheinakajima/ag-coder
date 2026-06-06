export const MODEL_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "claude-3-5-haiku-20241022", label: "claude-3-5-haiku" },
  { value: "claude-3-5-sonnet-20241022", label: "claude-3-5-sonnet" },
  { value: "gpt-4o-mini", label: "gpt-4o-mini" },
  { value: "gpt-4o", label: "gpt-4o" },
] as const;

export const PREFERRED_MODEL_KEY = "ag_preferred_model";

/**
 * Resolve a raw model id (as stored on a run) to a human-friendly label.
 * Returns null for empty / "demo" / "default" values so callers can omit the badge.
 */
export function getModelLabel(model: string | null | undefined): string | null {
  if (!model || model === "demo" || model === "default") return null;
  return MODEL_OPTIONS.find((o) => o.value === model)?.label ?? model;
}
