/**
 * Multi-environment account-limits state.
 *
 * Every connected environment reports its cached snapshot per provider
 * instance. The client keeps the freshest snapshot for each environment and
 * instance pair so independently configured accounts remain visible.
 *
 * @module state/accountLimits
 */
import { useAtomValue } from "@effect/atom-react";
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  type AccountLimitsSnapshot,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentLimitsStatus {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly snapshots: readonly AccountLimitsSnapshot[] | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}

const accountLimitsAtom = Atom.make((get): readonly EnvironmentLimitsStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentLimitsStatus[] = [];
  for (const [environmentId] of presentations) {
    const result = get(serverEnvironment.accountLimits({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    const config = get(serverEnvironment.configValueAtom(environmentId));
    statuses.push({
      environmentId,
      isPending: result.waiting,
      providers: config?.providers ?? [],
      snapshots:
        summary === null || summary.contractVersion !== ACCOUNT_LIMITS_CONTRACT_VERSION
          ? null
          : summary.snapshots,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-account-limits"));

export interface AccountLimitsView {
  /** Freshest snapshot per environment and provider instance. */
  readonly snapshots: ReadonlyArray<AccountLimitsSnapshotView>;
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while any environment is still answering. A provider with no
   * snapshot is "loading" while this holds and "no data" once it clears -
   * the first environment to answer must not decide that for the rest.
   */
  readonly isSettling: boolean;
  readonly refresh: () => void;
}

export interface AccountLimitsSnapshotView {
  readonly environmentId: EnvironmentId;
  readonly displayName: string;
  readonly snapshot: AccountLimitsSnapshot;
}

export function mergeAccountLimitSnapshots(
  environments: ReadonlyArray<EnvironmentLimitsStatus>,
): ReadonlyArray<AccountLimitsSnapshotView> {
  const freshest = new Map<string, AccountLimitsSnapshotView>();
  for (const environment of environments) {
    for (const snapshot of environment.snapshots ?? []) {
      const key = `${environment.environmentId}:${snapshot.providerInstanceId}`;
      const current = freshest.get(key);
      if (current !== undefined && current.snapshot.asOf >= snapshot.asOf) continue;
      const provider = environment.providers.find(
        (candidate) => candidate.instanceId === snapshot.providerInstanceId,
      );
      freshest.set(key, {
        environmentId: environment.environmentId,
        displayName: provider?.displayName ?? snapshot.providerInstanceId,
        snapshot,
      });
    }
  }
  const values = [...freshest.values()];
  const labelCounts = new Map<string, number>();
  for (const entry of values) {
    const key = `${entry.snapshot.provider}:${entry.displayName.toLocaleLowerCase()}`;
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  const disambiguated = values.map((entry) => {
    const labelKey = `${entry.snapshot.provider}:${entry.displayName.toLocaleLowerCase()}`;
    const isGenericLabel =
      entry.displayName.toLocaleLowerCase() === entry.snapshot.provider.toLocaleLowerCase();
    return isGenericLabel || (labelCounts.get(labelKey) ?? 0) > 1
      ? { ...entry, displayName: entry.snapshot.providerInstanceId }
      : entry;
  });
  return disambiguated.sort(
    (a, b) =>
      a.snapshot.provider.localeCompare(b.snapshot.provider) ||
      a.displayName.localeCompare(b.displayName) ||
      a.snapshot.providerInstanceId.localeCompare(b.snapshot.providerInstanceId),
  );
}

export function useAccountLimits(): AccountLimitsView {
  const environments = useAtomValue(accountLimitsAtom);

  const snapshots = useMemo(() => mergeAccountLimitSnapshots(environments), [environments]);

  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.accountLimits({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const answered = environments.filter((environment) => environment.snapshots !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.snapshots === null && environment.isPending,
  ).length;

  return {
    snapshots,
    isPending: answered === 0 && stillReporting > 0,
    isSettling: stillReporting > 0,
    refresh,
  };
}
