import { recordError } from './diagnostics';

// Clock-skew detection.
//
// Every merge in this app is last-writer-wins on `Date.now()` taken from the
// device that wrote the field (sync/field-timestamps.ts). A device whose clock
// runs ahead therefore wins EVERY field comparison until real time catches up,
// and the other device's later edits are dropped with no error anywhere — the
// hardest failure of this architecture to diagnose from the outside.
//
// Correcting the stamps is not an option: they are the merge order, and rewriting
// them on receipt would break convergence between devices that disagree. What we
// can do is notice. Every GitHub API response carries a `Date` header, which is a
// free, authoritative clock reading from a third party; comparing it with the
// local clock on each sync turns an invisible failure into a recorded one.

/** Beyond this, LWW ordering between devices is no longer trustworthy. */
export const SKEW_WARN_MS = 5 * 60_000;
/** Re-report only when the reading moves by at least this much (no log spam). */
const REPORT_STEP_MS = 60_000;

let lastSkewMs: number | null = null;
let lastReportedSkewMs: number | null = null;

/**
 * Feed the `Date` header of a server response. Returns the skew in ms — positive
 * means this device's clock is AHEAD of the server — or null if the header was
 * missing or unparseable.
 */
export function recordServerDate(header: string | null | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return null;

  // The header has second resolution and the round trip costs a moment, so
  // anything inside a couple of seconds is measurement noise, not skew.
  const skew = now - serverMs;
  lastSkewMs = skew;

  if (Math.abs(skew) >= SKEW_WARN_MS) {
    const moved = lastReportedSkewMs === null || Math.abs(skew - lastReportedSkewMs) >= REPORT_STEP_MS;
    if (moved) {
      lastReportedSkewMs = skew;
      recordError(
        'clock.skew',
        new Error(
          `Device clock is ${skew > 0 ? 'ahead of' : 'behind'} the server by ${formatSkew(Math.abs(skew))}. ` +
          'Edits merge by timestamp, so a wrong clock can silently overwrite or lose changes from other devices.',
        ),
      );
    }
  } else {
    lastReportedSkewMs = null; // back in range — a new excursion is worth reporting
  }
  return skew;
}

/** Last measured skew in ms (positive = this device is ahead), or null. */
export function getClockSkewMs(): number | null {
  return lastSkewMs;
}

/** True when the local clock is far enough off that merge order can't be trusted. */
export function isClockSkewed(): boolean {
  return lastSkewMs !== null && Math.abs(lastSkewMs) >= SKEW_WARN_MS;
}

export function formatSkew(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.round(totalMinutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** Tests only. */
export function __resetClockSkewForTests(): void {
  lastSkewMs = null;
  lastReportedSkewMs = null;
}
