// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings as ServerSettingsContract,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AccountLimitsService,
  deriveCodexLimitInstanceConfigs,
  layer,
} from "./AccountLimitsService.ts";

const makeTestLayer = (settings: Partial<ServerSettingsContract> = {}) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-account-limits-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const codexRateLimits = (usedPercent: number) => ({
  limit_id: "codex",
  primary: { used_percent: usedPercent, window_minutes: 10_080 },
  plan_type: "plus",
});

describe("AccountLimitsService", () => {
  it("derives every configured Codex instance for transcript recovery", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        codex: { driver: "codex", enabled: true, config: { homePath: "/tmp/codex-main" } },
        codex_work: {
          driver: "codex",
          enabled: true,
          config: { homePath: "/tmp/codex-work" },
        },
        claudeAgent: { driver: "claudeAgent", enabled: true, config: {} },
      },
    } as unknown as ServerSettingsContract;

    expect(
      deriveCodexLimitInstanceConfigs(settings).map(([providerInstanceId]) => providerInstanceId),
    ).toEqual(["codex", "codex_work"]);
  });

  it.effect("stores rate limits independently for each provider instance", () =>
    Effect.gen(function* () {
      const service = yield* AccountLimitsService;
      yield* service.ingest({
        provider: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_personal"),
        payload: codexRateLimits(20),
        createdAt: "2026-08-09T11:59:00.000Z",
      });
      yield* service.ingest({
        provider: "codex",
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        payload: codexRateLimits(80),
        createdAt: "2026-08-09T11:58:00.000Z",
      });

      const summary = yield* service.readSummary();

      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.providerInstanceId,
          snapshot.windows[0]?.usedPercent,
        ]),
      ).toEqual([
        ["codex_personal", 20],
        ["codex_work", 80],
      ]);
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("recovers independent transcript snapshots from two configured Codex homes", () => {
    let root = "";
    return Effect.gen(function* () {
      const settings = yield* Effect.sync(() => {
        root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-account-homes-"));
        const personalHome = NodePath.join(root, "personal");
        const workHome = NodePath.join(root, "work");
        const writeTranscript = (home: string, usedPercent: number, timestamp: string) => {
          const sessionsDir = NodePath.join(home, "sessions", "2026", "08", "09");
          NodeFS.mkdirSync(sessionsDir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(sessionsDir, "rollout.jsonl"),
            `${JSON.stringify({
              timestamp,
              payload: { rate_limits: codexRateLimits(usedPercent) },
            })}\n`,
          );
        };
        writeTranscript(personalHome, 20, "2026-08-09T11:59:00.000Z");
        writeTranscript(workHome, 80, "2026-08-09T11:58:00.000Z");
        return {
          providers: { codex: { enabled: false } },
          providerInstances: {
            codex_personal: {
              driver: "codex",
              enabled: true,
              config: { homePath: personalHome },
            },
            codex_work: {
              driver: "codex",
              enabled: true,
              config: { homePath: workHome },
            },
          },
        } as unknown as Partial<ServerSettingsContract>;
      });
      const summary = yield* Effect.gen(function* () {
        yield* TestClock.adjust("2 minutes");
        const service = yield* AccountLimitsService;
        return yield* service.readSummary();
      }).pipe(Effect.provide(makeTestLayer(settings)));

      expect(
        summary.snapshots.map((snapshot) => [
          snapshot.providerInstanceId,
          snapshot.windows[0]?.usedPercent,
          snapshot.source,
        ]),
      ).toEqual([
        ["codex_personal", 20, "transcript"],
        ["codex_work", 80, "transcript"],
      ]);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (root !== "") NodeFS.rmSync(root, { recursive: true, force: true });
        }),
      ),
    );
  });
});
