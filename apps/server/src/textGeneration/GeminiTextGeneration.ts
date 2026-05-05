import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type GeminiSettings, type ModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveGeminiApiModelId } from "@t3tools/shared/model";

import {
  cleanupGeminiSystemSettings,
  readGeminiLaunchEnv,
  writeGeminiModelAliasSettings,
} from "../provider/geminiCliFiles.ts";
import { resolveGeminiBinaryPath } from "../provider/geminiBinaryPath.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  extractJsonValueFromText,
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const GEMINI_TIMEOUT_MS = 180_000;

const GeminiOutputEnvelope = Schema.Struct({
  response: Schema.String,
  session_id: Schema.optional(Schema.String),
  stats: Schema.optional(Schema.Unknown),
});

export const makeGeminiTextGeneration = Effect.fn("makeGeminiTextGeneration")(function* (
  geminiSettings: GeminiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("gemini", operation, cause, "Failed to collect process output"),
      ),
    );

  const runGeminiJson = Effect.fn("runGeminiJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const runGeminiCommand = Effect.fn("runGeminiJson.runGeminiCommand")(function* () {
      const binaryPath = resolveGeminiBinaryPath(geminiSettings.binaryPath);
      const launchConfig = yield* Effect.tryPromise({
        try: async () => {
          const modelAliasSettings = await writeGeminiModelAliasSettings({
            scopeId: `git-${operation}`,
            modelIds: [modelSelection.model],
          });
          const env = await readGeminiLaunchEnv(modelAliasSettings.env);
          return {
            ...modelAliasSettings,
            ...(env ? { env } : {}),
          };
        },
        catch: (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to prepare Gemini CLI launch environment.",
            cause,
          }),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => cleanupGeminiSystemSettings(launchConfig.systemSettingsPath)),
      );
      const command = ChildProcess.make(
        binaryPath,
        [
          "--prompt",
          "",
          "--model",
          resolveGeminiApiModelId(modelSelection.model, modelSelection.options),
          "--output-format",
          "json",
          "--approval-mode",
          "plan",
        ],
        {
          cwd,
          env: launchConfig.env ? { ...environment, ...launchConfig.env } : environment,
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(prompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("gemini", operation, cause, "Failed to spawn Gemini CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("gemini", operation, cause, "Failed to read Gemini CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Gemini CLI command failed: ${detail}`
              : `Gemini CLI command failed with code ${exitCode}.`,
        });
      }

      return stdout;
    });

    const rawStdout = yield* runGeminiCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(GEMINI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Gemini CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(GeminiOutputEnvelope))(
      rawStdout,
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Gemini CLI returned unexpected output format.",
            cause,
          }),
        ),
      ),
    );

    const decodedStructuredOutput = yield* Effect.try({
      try: () => extractJsonValueFromText(envelope.response),
      catch: (cause) =>
        new TextGenerationError({
          operation,
          detail: "Gemini CLI response did not contain valid structured JSON.",
          cause,
        }),
    });

    return yield* Schema.decodeEffect(outputSchemaJson)(decodedStructuredOutput).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Gemini returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "GeminiTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runGeminiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "GeminiTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runGeminiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "GeminiTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runGeminiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "GeminiTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runGeminiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
