import { GeminiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeGeminiTextGeneration } from "../../textGeneration/GeminiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeGeminiAdapter } from "../Layers/GeminiAdapter.ts";
import { checkGeminiProviderStatus, makePendingGeminiProvider } from "../Layers/GeminiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("gemini");
const SNAPSHOT_REFRESH_INTERVAL = Duration.hours(1);
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@google/gemini-cli",
  homebrewFormula: null,
  nativeUpdate: null,
});
const decodeDefaultGeminiSettings = Schema.decodeSync(GeminiSettings);

export type GeminiDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: `${DRIVER_KIND}:instance:${input.instanceId}` },
  });

export const GeminiDriver: ProviderDriver<GeminiSettings, GeminiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Gemini",
    supportsMultipleInstances: true,
  },
  configSchema: GeminiSettings,
  defaultConfig: (): GeminiSettings => decodeDefaultGeminiSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies GeminiSettings;
      const stampIdentity = withInstanceIdentity({ instanceId, displayName, accentColor });
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeGeminiAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeGeminiTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkGeminiProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(ServerConfig, serverConfig),
      );
      const snapshot = yield* makeManagedServerProvider<GeminiSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingGeminiProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Gemini snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: defaultProviderContinuationIdentity({
          driverKind: DRIVER_KIND,
          instanceId,
        }),
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
