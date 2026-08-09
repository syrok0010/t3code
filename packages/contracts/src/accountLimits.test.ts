import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AccountLimitsSummary } from "./accountLimits.ts";

const decodeSummary = Schema.decodeUnknownSync(AccountLimitsSummary);

describe("AccountLimitsSummary", () => {
  it("preserves separate snapshots for instances of the same provider", () => {
    const summary = decodeSummary({
      contractVersion: 2,
      readAt: "2026-08-09T12:00:00.000Z",
      snapshots: [
        {
          provider: "codex",
          providerInstanceId: "codex_personal",
          plan: "plus",
          windows: [],
          asOf: "2026-08-09T11:59:00.000Z",
          source: "live",
        },
        {
          provider: "codex",
          providerInstanceId: "codex_work",
          plan: "team",
          windows: [],
          asOf: "2026-08-09T11:58:00.000Z",
          source: "live",
        },
      ],
    });

    expect(summary.snapshots.map((snapshot) => snapshot.providerInstanceId)).toEqual([
      "codex_personal",
      "codex_work",
    ]);
  });
});
