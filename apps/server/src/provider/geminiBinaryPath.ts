export function resolveGeminiBinaryPath(binaryPath: string | undefined): string {
  const trimmed = binaryPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "gemini";
}
