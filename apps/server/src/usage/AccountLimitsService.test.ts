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
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  AccountLimitsService,
  deriveCodexLimitInstanceConfigs,
  layer,
} from "./AccountLimitsService.ts";

const makeTestLayer = (settings: Partial<ServerSettingsContract> = {}, baseDir?: string) =>
  layer.pipe(
    Layer.provide(ServerSettings.layerTest(settings)),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), baseDir ?? { prefix: "t3-account-limits-test-" }).pipe(
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
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const makeTempDirectory = (prefix: string) =>
  Effect.acquireRelease(
    Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix))),
    (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
const writeCodexTranscript = (home: string, usedPercent: number, timestamp: string) => {
  const sessionsDir = NodePath.join(home, "sessions", "2026", "08", "09");
  NodeFS.mkdirSync(sessionsDir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(sessionsDir, "rollout.jsonl"),
    `${encodeUnknownJson({
      timestamp,
      payload: { rate_limits: codexRateLimits(usedPercent) },
    })}\n`,
  );
};

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

  it.effect("recovers independent transcript snapshots from two configured Codex homes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectory("t3-account-homes-");
        const personalHome = NodePath.join(root, "personal");
        const workHome = NodePath.join(root, "work");
        yield* Effect.sync(() => {
          writeCodexTranscript(personalHome, 20, "2026-08-09T11:59:00.000Z");
          writeCodexTranscript(workHome, 80, "2026-08-09T11:58:00.000Z");
        });
        const settings = {
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
      }),
    ),
  );

  it.effect("does not copy a shared transcript snapshot across shadow-home accounts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* makeTempDirectory("t3-account-shadows-");
        const fixture = yield* Effect.sync(() => {
          const sharedHome = NodePath.join(root, "shared");
          const baseDir = NodePath.join(root, "state");
          const stateDir = NodePath.join(baseDir, "userdata");
          NodeFS.mkdirSync(stateDir, { recursive: true });
          writeCodexTranscript(sharedHome, 2, "2026-08-09T11:59:00.000Z");
          NodeFS.writeFileSync(
            NodePath.join(stateDir, "account-limits.json"),
            encodeUnknownJson([
              {
                provider: "codex",
                providerInstanceId: "codex_personal",
                plan: "plus",
                windows: [
                  {
                    id: "seven_day",
                    label: "Week",
                    usedPercent: 2,
                    resetsAt: null,
                    windowMinutes: 10_080,
                  },
                ],
                asOf: "2026-08-09T11:59:00.000Z",
                source: "transcript",
              },
              {
                provider: "codex",
                providerInstanceId: "codex_work",
                plan: "plus",
                windows: [
                  {
                    id: "seven_day",
                    label: "Week",
                    usedPercent: 77,
                    resetsAt: null,
                    windowMinutes: 10_080,
                  },
                ],
                asOf: "2026-08-09T12:00:00.000Z",
                source: "live",
              },
            ]),
          );
          return {
            baseDir,
            settings: {
              providers: { codex: { enabled: false } },
              providerInstances: {
                codex_personal: {
                  driver: "codex",
                  enabled: true,
                  config: {
                    homePath: sharedHome,
                    shadowHomePath: NodePath.join(root, "personal-shadow"),
                  },
                },
                codex_work: {
                  driver: "codex",
                  enabled: true,
                  config: {
                    homePath: sharedHome,
                    shadowHomePath: NodePath.join(root, "work-shadow"),
                  },
                },
              },
            } as unknown as Partial<ServerSettingsContract>,
          };
        });

        const summary = yield* Effect.gen(function* () {
          yield* TestClock.adjust("2 minutes");
          const service = yield* AccountLimitsService;
          return yield* service.readSummary();
        }).pipe(Effect.provide(makeTestLayer(fixture.settings, fixture.baseDir)));

        expect(
          summary.snapshots.map((snapshot) => [
            snapshot.providerInstanceId,
            snapshot.windows[0]?.usedPercent,
            snapshot.source,
          ]),
        ).toEqual([["codex_work", 77, "live"]]);
      }),
    ),
  );
});
