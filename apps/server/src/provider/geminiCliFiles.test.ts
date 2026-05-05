import assert from "node:assert/strict";
import { describe, it } from "@effect/vitest";

import { parseGeminiEnvFile } from "./geminiCliFiles.ts";

describe("parseGeminiEnvFile", () => {
  it("parses Gemini CLI dotenv files", () => {
    assert.deepStrictEqual(
      parseGeminiEnvFile(String.raw`
# comment
GOOGLE_CLOUD_PROJECT=t3-code-enterprise
export GOOGLE_CLOUD_PROJECT_ID="project-id"
GEMINI_API_KEY='api-key'
INVALID-KEY=ignored
EMPTY=
ESCAPED_NEWLINE="hello\nworld"
ESCAPED_QUOTE="hello \"world\""
ESCAPED_BACKSLASH="path\\to\\file"
LITERAL_BACKSLASH_N="hello\\nworld"
`),
      {
        GOOGLE_CLOUD_PROJECT: "t3-code-enterprise",
        GOOGLE_CLOUD_PROJECT_ID: "project-id",
        GEMINI_API_KEY: "api-key",
        EMPTY: "",
        ESCAPED_NEWLINE: "hello\nworld",
        ESCAPED_QUOTE: `hello "world"`,
        ESCAPED_BACKSLASH: String.raw`path\to\file`,
        LITERAL_BACKSLASH_N: String.raw`hello\nworld`,
      },
    );
  });
});
