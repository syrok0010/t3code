import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime.ts";

export interface GeminiAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly binaryPath: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly approvalMode?: string;
}

export function buildGeminiAcpSpawnInput(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly approvalMode?: string;
}): AcpSpawnInput {
  return {
    command: input.binaryPath,
    args: ["--acp", ...(input.approvalMode ? [`--approval-mode=${input.approvalMode}`] : [])],
    cwd: input.cwd,
    ...(input.env ? { env: input.env } : {}),
  };
}

export const makeGeminiAcpRuntime = (
  input: GeminiAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGeminiAcpSpawnInput(input),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });
