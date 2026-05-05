import { trimOrNull } from "./model.ts";

function formatTitleCaseToken(token: string): string {
  const normalized = token.trim();
  if (!normalized) {
    return "";
  }

  const lower = normalized.toLowerCase();
  switch (lower) {
    case "ai":
      return "AI";
    case "api":
      return "API";
    case "gpt":
      return "GPT";
    default:
      return lower[0]?.toUpperCase() + lower.slice(1);
  }
}

export function formatGeminiModelDisplayName(model: string | null | undefined): string {
  const trimmed = trimOrNull(model);
  if (!trimmed) {
    return "";
  }

  const autoMatch = /^auto-gemini-(.+)$/i.exec(trimmed);
  if (autoMatch) {
    const autoSuffix = autoMatch[1] ?? "";
    const suffix = autoSuffix
      .split(/[-_]+/g)
      .filter((segment) => segment.length > 0)
      .map((segment) => formatTitleCaseToken(segment))
      .join(" ");
    return suffix ? `Auto (Gemini ${suffix})` : "Auto (Gemini)";
  }

  const body = trimmed.replace(/^gemini[-_]?/i, "");
  const suffix = body
    .split(/[-_]+/g)
    .filter((segment) => segment.length > 0)
    .map((segment) => formatTitleCaseToken(segment))
    .join(" ");
  return suffix ? `Gemini ${suffix}` : "Gemini";
}
