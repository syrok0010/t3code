import { ProviderDriverKind, type GeminiSettings } from "@t3tools/contracts";
import { formatGeminiModelDisplayName } from "@t3tools/shared/gemini";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  probeGeminiCapabilities,
  type GeminiCapabilityProbeResult,
} from "../geminiAcpProbe.ts";
import { resolveGeminiBinaryPath } from "../geminiBinaryPath.ts";
import { ServerConfig } from "../../config.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("gemini");
const GEMINI_PRESENTATION = {
  displayName: "Gemini",
  showInteractionModeToggle: true,
} as const;

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (
  geminiSettings: GeminiSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
) {
  const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
  const command = ChildProcess.make(binaryPath, [...args], {
    ...(environment ? { env: environment } : {}),
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(function* (
  geminiSettings: GeminiSettings,
  environment?: NodeJS.ProcessEnv,
  resolveCapabilities?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
  }) => Effect.Effect<GeminiCapabilityProbeResult>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ServerConfig
> {
  const serverConfig = yield* ServerConfig;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = providerModelsFromSettings(
    [],
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
    { formatCustomModelName: formatGeminiModelDisplayName },
  );

  if (!geminiSettings.enabled) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini is disabled in T3 Code settings.",
      },
    });
  }

  const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
  const versionProbe = yield* runGeminiCommand(geminiSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: geminiSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      },
    });
  }

  const capabilityProbe = yield* (resolveCapabilities ?? probeGeminiCapabilities)({
    binaryPath,
    cwd: serverConfig.cwd,
  });
  const models = providerModelsFromSettings(
    capabilityProbe.models,
    PROVIDER,
    geminiSettings.customModels,
    DEFAULT_GEMINI_MODEL_CAPABILITIES,
    { formatCustomModelName: formatGeminiModelDisplayName },
  );

  return buildServerProvider({
    presentation: GEMINI_PRESENTATION,
    enabled: geminiSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: parsedVersion,
      status: capabilityProbe.status,
      auth: capabilityProbe.auth,
      ...(capabilityProbe.message ? { message: capabilityProbe.message } : {}),
    },
  });
});

export const makePendingGeminiProvider = (
  geminiSettings: GeminiSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = providerModelsFromSettings(
      [],
      PROVIDER,
      geminiSettings.customModels,
      DEFAULT_GEMINI_MODEL_CAPABILITIES,
      { formatCustomModelName: formatGeminiModelDisplayName },
    );

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        presentation: GEMINI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: GEMINI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Gemini provider status has not been checked in this session yet.",
      },
    });
  });
