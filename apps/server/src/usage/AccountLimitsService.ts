/**
 * AccountLimitsService - the server-wide account rate-limit cache.
 *
 * Fed passively: runtime ingestion forwards every
 * `account.rate-limits.updated` event here (Claude usage snapshots and
 * single-window events, Codex app-server notifications), and each Codex
 * provider health probe forwards its initial `account/rateLimits/read`
 * response. When asked and Codex has no live snapshot, the newest unambiguous
 * transcript snapshot is recovered from disk. Claude has no disk fallback:
 * its limits exist only on the live stream, which is why snapshots are
 * persisted across restarts.
 *
 * Snapshots are keyed by provider instance so independently configured
 * accounts never overwrite each other.
 *
 * @module AccountLimitsService
 */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  AccountLimitsSnapshot,
  type AccountLimitsSummary,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings as ServerSettingsContract,
  type UsageProviderKind,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import {
  claudeUsageSnapshotFromUnknown,
  claudeWindowFromRateLimitEvent,
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
  sortWindows,
} from "./accountLimitsNormalize.ts";
import { readLatestCodexRateLimits } from "./accountLimitsTranscripts.ts";

/** Failed or empty transcript scans are not retried more often than this. */
const CODEX_SEED_MIN_INTERVAL_MS = 60_000;
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER);

/** On-disk shape of the snapshot cache: the contract array, JSON-encoded. */
const LimitsCacheFile = Schema.Array(AccountLimitsSnapshot);
const decodeLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const encodeLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export function deriveCodexLimitInstanceConfigs(
  settings: ServerSettingsContract,
): ReadonlyArray<readonly [ProviderInstanceId, ProviderInstanceConfig]> {
  const instances = new Map<ProviderInstanceId, ProviderInstanceConfig>();
  for (const [rawInstanceId, instance] of Object.entries(settings.providerInstances)) {
    if (instance.driver !== CODEX_DRIVER) continue;
    instances.set(ProviderInstanceId.make(rawInstanceId), instance);
  }
  if (!(DEFAULT_CODEX_INSTANCE_ID in settings.providerInstances)) {
    instances.set(DEFAULT_CODEX_INSTANCE_ID, {
      driver: CODEX_DRIVER,
      config: settings.providers.codex,
    });
  }
  return [...instances.entries()];
}

export interface AccountLimitsIngestInput {
  /** Driver kind off the runtime event (`claudeAgent`, `codex`, ...). */
  readonly provider: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** The event's `payload.rateLimits`, in whatever shape the adapter emitted. */
  readonly payload: unknown;
  readonly createdAt: string;
}

export class AccountLimitsService extends Context.Service<
  AccountLimitsService,
  {
    readonly readSummary: () => Effect.Effect<AccountLimitsSummary>;
    readonly ingest: (input: AccountLimitsIngestInput) => Effect.Effect<void>;
  }
>()("t3/usage/AccountLimitsService") {}

/** Empty cache, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  AccountLimitsService,
  AccountLimitsService.of({
    readSummary: () =>
      Effect.succeed({
        contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        snapshots: [],
      }),
    ingest: () => Effect.void,
  }),
);

function providerFromDriver(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return null;
}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const snapshots = new Map<ProviderInstanceId, AccountLimitsSnapshot>();
  const cachePath = path.join(config.stateDir, "account-limits.json");
  const lastCodexSeedAttemptAtMs = new Map<ProviderInstanceId, number>();

  // Restarts must not lose the Claude snapshot (stream-only, no disk source),
  // so the cache is persisted. Same Effect.cached trick as the usage scan
  // cache: concurrent first readers await one load.
  const ensureLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const stored = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeLimitsCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (stored === null) return;
      for (const snapshot of stored) {
        if (!snapshots.has(snapshot.providerInstanceId)) {
          snapshots.set(snapshot.providerInstanceId, snapshot);
        }
      }
    }),
  );

  /**
   * All snapshot mutations - event ingest (worker fiber) and the transcript
   * seed (RPC fiber) - run under this one permit, so each ordering guard,
   * map write, and persist is atomic with respect to the others. Without it
   * a concurrent pair can both pass their guard against the same prior
   * snapshot and land in either order, rolling the state backwards. Reads
   * stay lock-free.
   */
  const stateLock = yield* Semaphore.make(1);

  // A cache we cannot write is a colder next start, not a failure. Only
  // called while holding `stateLock`, which is what serializes writes; the
  // temp-file + rename keeps a crashed write from tearing the file.
  const persist = Effect.fn("AccountLimitsService.persist")(function* () {
    yield* encodeLimitsCache([...snapshots.values()]).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: cachePath, contents: serialized }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() => Effect.void),
    );
  });

  const store = Effect.fn("AccountLimitsService.store")(function* (
    snapshot: AccountLimitsSnapshot,
  ) {
    snapshots.set(snapshot.providerInstanceId, snapshot);
    yield* persist();
  });

  const ingestClaude = Effect.fn("AccountLimitsService.ingestClaude")(function* (
    providerInstanceId: ProviderInstanceId,
    payload: unknown,
    createdAt: string,
  ) {
    const previous = snapshots.get(providerInstanceId);
    const full = claudeUsageSnapshotFromUnknown(payload);
    if (full !== null) {
      // Rate limits do not apply to this account (API key / Bedrock / Vertex):
      // nothing to show, and nothing worth clearing a previous snapshot over.
      if (full.windows.length === 0) return;
      yield* store({
        provider: "claude",
        providerInstanceId,
        plan: full.plan ?? previous?.plan ?? null,
        windows: full.windows,
        asOf: createdAt,
        source: "live",
      });
      return;
    }
    // The streamed event names one window; patch it into whatever set the
    // last full snapshot established.
    const window = claudeWindowFromRateLimitEvent(payload);
    if (window === null) return;
    const windows = sortWindows([
      ...(previous?.windows ?? []).filter((existing) => existing.id !== window.id),
      window,
    ]);
    yield* store({
      provider: "claude",
      providerInstanceId,
      plan: previous?.plan ?? null,
      windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingestCodex = Effect.fn("AccountLimitsService.ingestCodex")(function* (
    providerInstanceId: ProviderInstanceId,
    payload: unknown,
    createdAt: string,
  ) {
    const snapshot = codexSnapshotFromUnknown(payload);
    if (snapshot === null) return;
    // Per-model side meters (Spark) are not surfaced.
    if (!isPrimaryCodexLimit(snapshot.limitId)) return;
    if (snapshot.windows.length === 0) return;
    const previous = snapshots.get(providerInstanceId);
    yield* store({
      provider: "codex",
      providerInstanceId,
      plan: snapshot.plan ?? previous?.plan ?? null,
      windows: snapshot.windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
    input: AccountLimitsIngestInput,
  ) {
    const provider = providerFromDriver(input.provider);
    if (provider === null) return;
    yield* ensureLoaded;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        // Guard against out-of-order delivery: an event older than what is
        // already stored must not roll the snapshot backwards.
        const existing = snapshots.get(input.providerInstanceId);
        if (existing !== undefined && input.createdAt < existing.asOf) return;
        if (provider === "claude") {
          yield* ingestClaude(input.providerInstanceId, input.payload, input.createdAt);
        } else {
          yield* ingestCodex(input.providerInstanceId, input.payload, input.createdAt);
        }
      }),
    );
  });

  /**
   * Recovers the Codex snapshot from session transcripts when they are newer
   * than what the cache holds - which covers both a cold cache and Codex
   * sessions driven outside T3 Code.
   */
  const maybeSeedCodexFromTranscripts = Effect.fn("AccountLimitsService.seedCodex")(function* (
    nowMs: number,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (settings === null) return;
    const instanceConfigs = deriveCodexLimitInstanceConfigs(settings);
    const targets: Array<{
      readonly providerInstanceId: ProviderInstanceId;
      readonly sessionsDir: string;
    }> = [];
    for (const [providerInstanceId, instance] of instanceConfigs) {
      if (instance.enabled === false) continue;
      const codexSettings = yield* decodeCodexSettings(instance.config ?? {}).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (codexSettings === null || (instance.enabled ?? codexSettings.enabled) === false) continue;
      const layout = yield* resolveCodexHomeLayout({
        ...codexSettings,
        enabled: instance.enabled ?? codexSettings.enabled,
      }).pipe(Effect.provideService(Path.Path, path));
      targets.push({
        providerInstanceId,
        sessionsDir: path.join(layout.sharedHomePath, "sessions"),
      });
    }

    const sessionsDirCounts = new Map<string, number>();
    for (const target of targets) {
      sessionsDirCounts.set(
        target.sessionsDir,
        (sessionsDirCounts.get(target.sessionsDir) ?? 0) + 1,
      );
    }

    // Shadow homes intentionally share transcripts with their common
    // CODEX_HOME. Transcript rate-limit records carry no account/instance
    // identity, so assigning the newest shared record to every shadow account
    // fabricates identical usage. Drop any old transcript-derived copies and
    // wait for an instance-tagged live event instead. Live snapshots remain
    // valid and are preserved across restarts by the cache.
    const ambiguousTargets = targets.filter(
      (target) => (sessionsDirCounts.get(target.sessionsDir) ?? 0) > 1,
    );
    if (ambiguousTargets.length > 0) {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          let changed = false;
          for (const target of ambiguousTargets) {
            if (snapshots.get(target.providerInstanceId)?.source !== "transcript") continue;
            snapshots.delete(target.providerInstanceId);
            changed = true;
          }
          if (changed) yield* persist();
        }),
      );
    }

    for (const target of targets) {
      if ((sessionsDirCounts.get(target.sessionsDir) ?? 0) > 1) continue;
      const lastAttemptAtMs = lastCodexSeedAttemptAtMs.get(target.providerInstanceId) ?? 0;
      if (nowMs - lastAttemptAtMs < CODEX_SEED_MIN_INTERVAL_MS) continue;
      lastCodexSeedAttemptAtMs.set(target.providerInstanceId, nowMs);

      const found = yield* Effect.promise(() =>
        readLatestCodexRateLimits(target.sessionsDir, nowMs),
      );
      if (found === null) continue;

      const asOf = DateTime.formatIso(DateTime.makeUnsafe(found.asOfMs));
      // The slow transcript read happened outside the lock; only the
      // guard-and-store is serialized against live ingests.
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = snapshots.get(target.providerInstanceId);
          // ISO-8601 strings order lexicographically.
          if (existing !== undefined && existing.asOf >= asOf) return;
          yield* store({
            provider: "codex",
            providerInstanceId: target.providerInstanceId,
            plan: found.snapshot.plan ?? existing?.plan ?? null,
            windows: found.snapshot.windows,
            asOf,
            source: "transcript",
          });
        }),
      );
    }
  });

  const readSummary = Effect.fn("AccountLimitsService.readSummary")(function* () {
    yield* ensureLoaded;
    const nowMs = yield* Clock.currentTimeMillis;
    yield* maybeSeedCodexFromTranscripts(nowMs).pipe(Effect.catchCause(() => Effect.void));
    return {
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      snapshots: [...snapshots.values()].sort(
        (a, b) =>
          a.provider.localeCompare(b.provider) ||
          a.providerInstanceId.localeCompare(b.providerInstanceId),
      ),
    } satisfies AccountLimitsSummary;
  });

  return { readSummary, ingest } as const;
});

export const layer = Layer.effect(AccountLimitsService, make);
