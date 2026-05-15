import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  GEMINI_2_5_MODEL_CAPABILITIES,
  GEMINI_3_MODEL_CAPABILITIES,
  geminiCapabilitiesForModel,
} from "@t3tools/shared/model";
import { formatGeminiModelDisplayName } from "@t3tools/shared/gemini";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeGeminiAcpRuntime } from "./acp/GeminiAcpSupport.ts";
import { readGeminiLaunchEnv } from "./geminiCliFiles.ts";
import { asNumber, asRecord, trimToUndefined } from "./jsonValue.ts";

const GEMINI_ACP_PROBE_TIMEOUT_MS = 8_000;
const GEMINI_ACP_AUTH_REQUIRED_CODE = -32_000;

export {
  DEFAULT_GEMINI_MODEL_CAPABILITIES,
  GEMINI_2_5_MODEL_CAPABILITIES,
  GEMINI_3_MODEL_CAPABILITIES,
  geminiCapabilitiesForModel,
};

export type GeminiCapabilityProbeResult = {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: Pick<ServerProviderAuth, "status">;
  readonly message?: string;
};

function formatGeminiDiscoveryWarning(detail: string): string {
  return `Gemini CLI is installed, but T3 Code could not verify authentication or discover models. ${detail}`;
}

function formatGeminiAuthMessage(detail: string): string {
  return `Gemini is not authenticated. ${detail}`;
}

export function parseGeminiAcpProbeError(
  error: unknown,
): Omit<GeminiCapabilityProbeResult, "models"> {
  const record = asRecord(error);
  const code = asNumber(record?.code);
  const message = trimToUndefined(record?.message) ?? "Gemini ACP request failed.";
  const lowerMessage = message.toLowerCase();
  const unauthenticated =
    code === GEMINI_ACP_AUTH_REQUIRED_CODE ||
    lowerMessage.includes("authentication required") ||
    lowerMessage.includes("api key is missing") ||
    lowerMessage.includes("auth method") ||
    lowerMessage.includes("not configured");

  if (unauthenticated) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: formatGeminiAuthMessage(message),
    };
  }

  return {
    status: "warning",
    auth: { status: "unknown" },
    message: formatGeminiDiscoveryWarning(message),
  };
}

export function parseGeminiDiscoveredModels(
  response: unknown,
  fallbackCapabilities: ModelCapabilities = DEFAULT_GEMINI_MODEL_CAPABILITIES,
): ReadonlyArray<ServerProviderModel> {
  const availableModels = asRecord(asRecord(response)?.models)?.availableModels;
  if (!Array.isArray(availableModels)) {
    return [];
  }

  const discoveredModels: ServerProviderModel[] = [];
  const seen = new Set<string>();

  for (const candidate of availableModels) {
    const record = asRecord(candidate);
    const slug = trimToUndefined(record?.modelId);
    if (!slug || seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    const explicitName = trimToUndefined(record?.name);
    discoveredModels.push({
      slug,
      name:
        explicitName && explicitName.toLowerCase() !== slug.toLowerCase()
          ? explicitName
          : formatGeminiModelDisplayName(slug),
      isCustom: false,
      capabilities: geminiCapabilitiesForModel(slug, fallbackCapabilities),
    });
  }

  return discoveredModels;
}

export const probeGeminiCapabilities = (input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly capabilities?: ModelCapabilities;
}): Effect.Effect<GeminiCapabilityProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const env = yield* Effect.tryPromise({
        try: () => readGeminiLaunchEnv(),
        catch: () => undefined,
      });
      const runtime = yield* makeGeminiAcpRuntime({
        childProcessSpawner,
        binaryPath: input.binaryPath,
        cwd: input.cwd,
        ...(env ? { env } : {}),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false },
        },
      });

      const started = yield* runtime
        .start()
        .pipe(Effect.timeoutOption(GEMINI_ACP_PROBE_TIMEOUT_MS));
      if (Option.isNone(started)) {
        return {
          status: "warning" as const,
          auth: { status: "unknown" as const },
          models: [],
          message: formatGeminiDiscoveryWarning("Timed out while starting Gemini ACP session."),
        } satisfies GeminiCapabilityProbeResult;
      }

      const models = parseGeminiDiscoveredModels(
        started.value.sessionSetupResult,
        input.capabilities ?? DEFAULT_GEMINI_MODEL_CAPABILITIES,
      );
      if (models.length === 0) {
        return {
          status: "warning" as const,
          auth: { status: "authenticated" as const },
          models: [],
          message: formatGeminiDiscoveryWarning(
            "Gemini ACP session started, but it did not report any available models.",
          ),
        } satisfies GeminiCapabilityProbeResult;
      }

      return {
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        models,
        message: "Gemini CLI is installed and authenticated.",
      } satisfies GeminiCapabilityProbeResult;
    }),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        ...parseGeminiAcpProbeError(Cause.squash(cause)),
        models: [],
      }),
    ),
  );
