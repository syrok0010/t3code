import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCodexProbeLimitsIngest } from "../Drivers/CodexDriver.ts";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import {
  AccountLimitsService,
  type AccountLimitsIngestInput,
} from "../../usage/AccountLimitsService.ts";

const codexSettings = Schema.decodeSync(CodexSettings)({});

it.effect("forwards probed Codex rate limits with the checked instance timestamp", () =>
  Effect.gen(function* () {
    const observed = yield* Ref.make<{
      readonly rateLimits: CodexSchema.V2GetAccountRateLimitsResponse;
      readonly observedAt: string;
    } | null>(null);
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        planType: "pro" as const,
        primary: { usedPercent: 37, windowDurationMins: 10_080 },
      },
    } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

    yield* checkCodexProviderStatus(
      codexSettings,
      () =>
        Effect.succeed({
          version: "1.0.0",
          rateLimits,
          account: {
            account: { type: "chatgpt", email: "test@example.com", planType: "pro" },
            requiresOpenaiAuth: false,
          },
          models: [],
          skills: [],
        }),
      undefined,
      (snapshot, observedAt) => Ref.set(observed, { rateLimits: snapshot, observedAt }),
    );

    const result = yield* Ref.get(observed);
    assert.deepStrictEqual(result?.rateLimits, rateLimits);
    assert.match(result?.observedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps distinct instance ids when two Codex probes ingest limits", () =>
  Effect.gen(function* () {
    const ingested: AccountLimitsIngestInput[] = [];
    const accountLimits = AccountLimitsService.of({
      readSummary: () => Effect.die("unused"),
      ingest: (input) => Effect.sync(() => ingested.push(input)),
    });
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 37, windowDurationMins: 10_080 },
      },
    } satisfies CodexSchema.V2GetAccountRateLimitsResponse;

    yield* makeCodexProbeLimitsIngest(accountLimits, ProviderInstanceId.make("codex_personal"))(
      rateLimits,
      "2026-08-09T12:00:00.000Z",
    );
    yield* makeCodexProbeLimitsIngest(accountLimits, ProviderInstanceId.make("codex_work"))(
      rateLimits,
      "2026-08-09T12:00:01.000Z",
    );

    assert.deepStrictEqual(
      ingested.map((input) => input.providerInstanceId),
      ["codex_personal", "codex_work"],
    );
  }),
);
