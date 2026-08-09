/**
 * Account rate-limit views: the sidebar hover card and the usage page's
 * "Limits" strip. Both render whatever windows the server reports, so a
 * window a provider adds or brings back (Codex's paused 5-hour) appears
 * without a client change.
 *
 * Every percentage is labelled `used` inline - a bare number cannot say
 * whether it is used or remaining. Snapshot age only renders once the data
 * is actually stale; fresh data needs no caption.
 *
 * @module AccountLimits
 */
import type { AccountLimitsSnapshot, AccountLimitsWindow } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useAccountLimits, type AccountLimitsSnapshotView } from "../../state/accountLimits";
import { formatAgo, formatResetAt } from "@t3tools/shared/limitsFormat";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

/** Age past which a snapshot stops being "current" and earns a caption. */
const STALE_AFTER_MS = 15 * 60_000;

/**
 * Reset countdowns and snapshot ages drift as time passes, not as data
 * changes; a coarse tick keeps them honest without re-fetching.
 */
function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

function usageTone(usedPercent: number): string | undefined {
  if (usedPercent >= 95) return "text-red-400";
  if (usedPercent >= 80) return "text-amber-400";
  return undefined;
}

function LimitMeter({ window, color }: { window: AccountLimitsWindow; color: string }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

/** `6h ago`, and only once the snapshot is old enough to matter. */
function SnapshotAge({ snapshot, nowMs }: { snapshot: AccountLimitsSnapshot; nowMs: number }) {
  const ageMs = nowMs - Date.parse(snapshot.asOf);
  if (!Number.isFinite(ageMs) || ageMs < STALE_AFTER_MS) return null;
  return (
    <span className="text-[10px] text-muted-foreground">{formatAgo(snapshot.asOf, nowMs)}</span>
  );
}

function entriesForProvider(
  snapshots: ReadonlyArray<AccountLimitsSnapshotView>,
  provider: AccountLimitsSnapshot["provider"],
): ReadonlyArray<AccountLimitsSnapshotView> {
  return snapshots.filter((entry) => entry.snapshot.provider === provider);
}

function snapshotViewKey(entry: AccountLimitsSnapshotView): string {
  return `${entry.environmentId}:${entry.snapshot.providerInstanceId}`;
}

function snapshotProviderLabel(entry: AccountLimitsSnapshotView): string {
  const providerLabel = PROVIDER_LABEL[entry.snapshot.provider];
  const instanceLabel = entry.displayName;
  return instanceLabel === entry.snapshot.provider || instanceLabel === providerLabel
    ? providerLabel
    : `${providerLabel} · ${instanceLabel}`;
}

type LimitsVariant = "compact" | "full";

function ProviderLimitsGroup({
  provider,
  entry,
  isSettling,
  nowMs,
  variant,
}: {
  provider: AccountLimitsSnapshot["provider"];
  entry: AccountLimitsSnapshotView | null;
  isSettling: boolean;
  nowMs: number;
  variant: LimitsVariant;
}) {
  const Mark = PROVIDER_MARK[provider];
  const compact = variant === "compact";
  if (entry === null) {
    return (
      <div className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
        <div className={cn("flex items-baseline", compact ? "gap-1.5" : "gap-2")}>
          <Mark className={cn("shrink-0 self-center", compact ? "size-3" : "size-3.5")} />
          <span className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>
            {PROVIDER_LABEL[provider]}
          </span>
        </div>
        <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
          {isSettling ? "Loading…" : "No limit data yet"}
        </p>
      </div>
    );
  }

  const snapshot = entry.snapshot;
  return (
    <div className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
      <div className={cn("flex items-baseline", compact ? "gap-1.5" : "gap-2")}>
        <Mark className={cn("shrink-0 self-center", compact ? "size-3" : "size-3.5")} />
        <span className={cn("font-medium text-foreground", compact ? "text-xs" : "text-sm")}>
          {snapshotProviderLabel(entry)}
        </span>
        <span className="ml-auto">
          <SnapshotAge snapshot={snapshot} nowMs={nowMs} />
        </span>
      </div>
      {snapshot.windows.length === 0 ? (
        <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>
          No limit data yet
        </p>
      ) : (
        snapshot.windows.map((window) => {
          const resetAt = formatResetAt(window.resetsAt, nowMs);
          return (
            <div key={window.id} className={cn("flex items-center", compact ? "gap-2" : "gap-3")}>
              <span
                className={cn(
                  "shrink-0 text-muted-foreground",
                  compact ? "w-9 text-[10px]" : "w-10 text-xs",
                )}
              >
                {window.label}
              </span>
              <LimitMeter window={window} color={PROVIDER_COLOR[provider]} />
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap text-right tabular-nums text-foreground",
                  compact ? "text-[11px]" : "text-xs font-medium",
                  usageTone(window.usedPercent),
                )}
              >
                {Math.round(window.usedPercent)}% used
              </span>
              <span
                className={cn(
                  "shrink-0 whitespace-nowrap text-right tabular-nums text-muted-foreground",
                  compact ? "text-[10px]" : "text-xs",
                )}
              >
                {resetAt === null ? "" : compact ? resetAt : `resets ${resetAt}`}
              </span>
            </div>
          );
        })
      )}
    </div>
  );
}

function ProviderLimitsGroups({
  snapshots,
  isSettling,
  nowMs,
  variant,
}: {
  snapshots: ReadonlyArray<AccountLimitsSnapshotView>;
  isSettling: boolean;
  nowMs: number;
  variant: LimitsVariant;
}) {
  return PROVIDER_ORDER.flatMap((provider) => {
    const entries = entriesForProvider(snapshots, provider);
    if (entries.length === 0) {
      return [
        <ProviderLimitsGroup
          key={provider}
          provider={provider}
          entry={null}
          isSettling={isSettling}
          nowMs={nowMs}
          variant={variant}
        />,
      ];
    }
    return entries.map((entry) => (
      <ProviderLimitsGroup
        key={snapshotViewKey(entry)}
        provider={provider}
        entry={entry}
        isSettling={isSettling}
        nowMs={nowMs}
        variant={variant}
      />
    ));
  });
}

// ---------------------------------------------------------------------------
// Sidebar hover card
// ---------------------------------------------------------------------------

/** Compact per-provider availability, shown on hovering the Usage button. */
export function AccountLimitsHoverCard() {
  const { snapshots, isPending, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  if (isPending && snapshots.length === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading limits…</p>;
  }

  return (
    <div className="flex w-64 flex-col gap-2.5 p-1.5">
      <ProviderLimitsGroups
        snapshots={snapshots}
        isSettling={isSettling}
        nowMs={nowMs}
        variant="compact"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage page section
// ---------------------------------------------------------------------------

/** The "Limits" strip above the analytics: one column per provider. */
export function AccountLimitsSection() {
  const { snapshots, isSettling } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Limits</h2>
      <div className="grid gap-x-12 gap-y-4 sm:grid-cols-2">
        <ProviderLimitsGroups
          snapshots={snapshots}
          isSettling={isSettling}
          nowMs={nowMs}
          variant="full"
        />
      </div>
    </section>
  );
}
