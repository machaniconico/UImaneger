import { env } from "./env.ts";

export const EDIT_MODELS = [
  { id: "claude-opus-4-8", label: "Opus 4.8", note: "高品質(既定)" },
  { id: "claude-sonnet-5", label: "Sonnet 5", note: "バランス・高速" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "最速・最安" },
] as const;

const ADAPTIVE_THINKING_MODELS = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-mythos-5",
]);

export function isAllowedEditModel(id: string): boolean {
  return EDIT_MODELS.some((model) => model.id === id) || id === env.editModel;
}

export function supportsAdaptiveThinking(id: string): boolean {
  return ADAPTIVE_THINKING_MODELS.has(id);
}
