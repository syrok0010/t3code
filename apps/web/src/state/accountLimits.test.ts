import type {
  AccountLimitsSnapshot,
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeAccountLimitSnapshots } from "./accountLimits";

function snapshot(input: {
  readonly instanceId: string;
  readonly asOf: string;
  readonly usedPercent: number;
}): AccountLimitsSnapshot {
  return {
    provider: "codex",
    providerInstanceId: input.instanceId as ProviderInstanceId,
    plan: "plus",
    windows: [
      {
        id: "seven_day",
        label: "Week",
        usedPercent: input.usedPercent,
        resetsAt: null,
        windowMinutes: 10_080,
      },
    ],
    asOf: input.asOf,
    source: "live",
  };
}

function provider(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: instanceId as ProviderInstanceId,
    driver: "codex" as ServerProvider["driver"],
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-09T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("mergeAccountLimitSnapshots", () => {
  it("keeps two Codex instances from one environment and resolves their labels", () => {
    const merged = mergeAccountLimitSnapshots([
      {
        environmentId: "environment-1" as EnvironmentId,
        isPending: false,
        snapshots: [
          snapshot({
            instanceId: "codex_personal",
            asOf: "2026-08-09T11:59:00.000Z",
            usedPercent: 20,
          }),
          snapshot({
            instanceId: "codex_work",
            asOf: "2026-08-09T11:58:00.000Z",
            usedPercent: 80,
          }),
        ],
        providers: [provider("codex_personal", "Personal"), provider("codex_work", "Work")],
      },
    ]);

    expect(merged.map((entry) => [entry.displayName, entry.snapshot.providerInstanceId])).toEqual([
      ["Personal", "codex_personal"],
      ["Work", "codex_work"],
    ]);
  });

  it("replaces only the same environment and provider instance with a fresher snapshot", () => {
    const merged = mergeAccountLimitSnapshots([
      {
        environmentId: "environment-1" as EnvironmentId,
        isPending: false,
        snapshots: [
          snapshot({
            instanceId: "codex_personal",
            asOf: "2026-08-09T11:00:00.000Z",
            usedPercent: 20,
          }),
        ],
        providers: [provider("codex_personal", "Personal")],
      },
      {
        environmentId: "environment-1" as EnvironmentId,
        isPending: false,
        snapshots: [
          snapshot({
            instanceId: "codex_personal",
            asOf: "2026-08-09T12:00:00.000Z",
            usedPercent: 30,
          }),
        ],
        providers: [provider("codex_personal", "Personal")],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snapshot.windows[0]?.usedPercent).toBe(30);
  });

  it("falls back to instance ids when Codex display names are generic or duplicated", () => {
    const merged = mergeAccountLimitSnapshots([
      {
        environmentId: "environment-1" as EnvironmentId,
        isPending: false,
        snapshots: [
          snapshot({
            instanceId: "codex_personal",
            asOf: "2026-08-09T11:59:00.000Z",
            usedPercent: 20,
          }),
          snapshot({
            instanceId: "codex_work",
            asOf: "2026-08-09T11:58:00.000Z",
            usedPercent: 80,
          }),
        ],
        providers: [provider("codex_personal", "Codex"), provider("codex_work", "Codex")],
      },
    ]);

    expect(merged.map((entry) => entry.displayName)).toEqual(["codex_personal", "codex_work"]);
  });
});
