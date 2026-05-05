import { describe, it, assert } from "@effect/vitest";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { checkGeminiProviderStatus } from "./GeminiProvider.ts";
import {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  GEMINI_2_5_MODEL_CAPABILITIES,
  GEMINI_3_MODEL_CAPABILITIES,
  geminiCapabilitiesForModel,
  parseGeminiAcpProbeError,
  parseGeminiDiscoveredModels,
} from "../geminiAcpProbe.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  handler: (input: { command: string; args: ReadonlyArray<string> }) => {
    stdout: string;
    stderr: string;
    code: number;
  },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler({ command: cmd.command, args: cmd.args })));
    }),
  );
}

function makeServerConfigLayer(cwd: string) {
  return Layer.succeed(ServerConfig, {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    mode: "web",
    port: 0,
    host: undefined,
    cwd,
    baseDir: "/tmp/t3code-gemini-provider-test",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    stateDir: "/tmp/t3code-gemini-provider-test/state",
    dbPath: "/tmp/t3code-gemini-provider-test/state/state.sqlite",
    keybindingsConfigPath: "/tmp/t3code-gemini-provider-test/state/keybindings.json",
    settingsPath: "/tmp/t3code-gemini-provider-test/state/settings.json",
    providerStatusCacheDir: "/tmp/t3code-gemini-provider-test/caches",
    worktreesDir: "/tmp/t3code-gemini-provider-test/worktrees",
    attachmentsDir: "/tmp/t3code-gemini-provider-test/state/attachments",
    logsDir: "/tmp/t3code-gemini-provider-test/state/logs",
    serverLogPath: "/tmp/t3code-gemini-provider-test/state/logs/server.log",
    serverTracePath: "/tmp/t3code-gemini-provider-test/state/logs/server.trace.ndjson",
    providerLogsDir: "/tmp/t3code-gemini-provider-test/state/logs/provider",
    providerEventLogPath: "/tmp/t3code-gemini-provider-test/state/logs/provider/events.log",
    terminalLogsDir: "/tmp/t3code-gemini-provider-test/state/logs/terminals",
    anonymousIdPath: "/tmp/t3code-gemini-provider-test/state/anonymous-id",
    environmentIdPath: "/tmp/t3code-gemini-provider-test/state/environment-id",
    serverRuntimeStatePath: "/tmp/t3code-gemini-provider-test/state/server-runtime.json",
    secretsDir: "/tmp/t3code-gemini-provider-test/state/secrets",
    tailscaleServeEnabled: false,
    tailscaleServePort: 0,
  } satisfies ServerConfigShape);
}

describe("parseGeminiDiscoveredModels", () => {
  it("deduplicates discovered Gemini models and ignores malformed entries", () => {
    const models = parseGeminiDiscoveredModels({
      models: {
        availableModels: [
          { modelId: "auto-gemini-3", name: "Auto (Gemini 3)" },
          { modelId: "gemini-2.5-pro" },
          { modelId: "auto-gemini-3", name: "Ignored duplicate" },
          { name: "Missing model id" },
          { modelId: "   " },
        ],
      },
    });

    assert.deepStrictEqual(models, [
      {
        slug: "auto-gemini-3",
        name: "Auto (Gemini 3)",
        isCustom: false,
        capabilities: GEMINI_3_MODEL_CAPABILITIES,
      },
      {
        slug: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        isCustom: false,
        capabilities: GEMINI_2_5_MODEL_CAPABILITIES,
      },
    ]);
  });
});

describe("geminiCapabilitiesForModel", () => {
  it("classifies Gemini 3 and Gemini 2.5 families for thinking controls", () => {
    assert.deepStrictEqual(
      geminiCapabilitiesForModel("auto-gemini-3"),
      GEMINI_3_MODEL_CAPABILITIES,
    );
    assert.deepStrictEqual(
      geminiCapabilitiesForModel("gemini-2.5-flash-lite"),
      GEMINI_2_5_MODEL_CAPABILITIES,
    );
    assert.deepStrictEqual(
      geminiCapabilitiesForModel("custom-model"),
      DEFAULT_GEMINI_MODEL_CAPABILITIES,
    );
  });
});

describe("parseGeminiAcpProbeError", () => {
  it("maps Gemini ACP auth errors to an unauthenticated provider state", () => {
    const parsed = parseGeminiAcpProbeError({
      code: -32_000,
      message: "Authentication required: Gemini API key is missing or not configured.",
    });

    assert.strictEqual(parsed.status, "error");
    assert.strictEqual(parsed.auth.status, "unauthenticated");
    assert.strictEqual(
      parsed.message,
      "Gemini is not authenticated. Authentication required: Gemini API key is missing or not configured.",
    );
  });
});

describe("checkGeminiProviderStatus", () => {
  it.effect("falls back to the system gemini binary when the configured path is blank", () => {
    const commands: string[] = [];
    const probedBinaryPaths: string[] = [];
    const probedCwds: string[] = [];
    const projectCwd = "/tmp/t3code-gemini-project";

    return Effect.gen(function* () {
      const status = yield* checkGeminiProviderStatus(
        { enabled: true, binaryPath: "", customModels: [] },
        undefined,
        (input) => {
          probedBinaryPaths.push(input.binaryPath);
          probedCwds.push(input.cwd);
          return Effect.succeed({
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            message: "Gemini CLI is installed and authenticated.",
            models: [],
          });
        },
      );

      assert.strictEqual(status.status, "ready");
      assert.deepStrictEqual(commands, ["gemini"]);
      assert.deepStrictEqual(probedBinaryPaths, ["gemini"]);
      assert.deepStrictEqual(probedCwds, [projectCwd]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeServerConfigLayer(projectCwd),
          mockSpawnerLayer(({ command, args }) => {
            commands.push(command);
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "gemini 0.37.1\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  it.effect("publishes Gemini models discovered from ACP and merges custom models", () =>
    Effect.gen(function* () {
      const status = yield* checkGeminiProviderStatus(
        {
          enabled: true,
          binaryPath: "gemini",
          customModels: ["gemini-custom-preview", "auto-gemini-next"],
        },
        undefined,
        () =>
          Effect.succeed({
            status: "ready" as const,
            auth: { status: "authenticated" as const },
            message: "Gemini CLI is installed and authenticated.",
            models: [
              {
                slug: "auto-gemini-next",
                name: "Auto (Gemini Next)",
                isCustom: false,
                capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
              },
              {
                slug: "gemini-4-pro",
                name: "Gemini 4 Pro",
                isCustom: false,
                capabilities: DEFAULT_GEMINI_MODEL_CAPABILITIES,
              },
            ],
          }),
      );

      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.auth.status, "authenticated");
      assert.deepStrictEqual(
        status.models.map((model) => model.slug),
        ["auto-gemini-next", "gemini-4-pro", "gemini-custom-preview"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeServerConfigLayer("/tmp/t3code-gemini-models"),
          mockSpawnerLayer(({ args }) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "gemini 0.37.1\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    ),
  );

  it.effect(
    "does not fall back to a hardcoded Gemini model list when ACP discovery is unavailable",
    () =>
      Effect.gen(function* () {
        const status = yield* checkGeminiProviderStatus(
          { enabled: true, binaryPath: "gemini", customModels: [] },
          undefined,
          () =>
            Effect.succeed({
              status: "warning" as const,
              auth: { status: "unknown" as const },
              message:
                "Gemini CLI is installed, but T3 Code could not verify authentication or discover models. Timed out while starting Gemini ACP session.",
              models: [],
            }),
        );

        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.models.length, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeServerConfigLayer("/tmp/t3code-gemini-unavailable"),
            mockSpawnerLayer(({ args }) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "gemini 0.37.1\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      ),
  );
});
