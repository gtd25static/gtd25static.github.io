/**
 * Field-level timestamps for sync conflict resolution.
 *
 * Instead of entity-level last-write-wins, each field tracks when it was last
 * modified. During merge, the newer value for each field wins independently.
 */

// `_enc` (ciphertext) and `_decryptError` (a quarantined row) are encryption
// bookkeeping, never data: a merge that adopted a remote `_enc` on the strength of
// its timestamp made the at-rest layer store the decrypted row verbatim.
const EXCLUDED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'fieldTimestamps', '_enc', '_decryptError']);

// Fields merged as id-keyed unions instead of whole-value LWW. discussionLog
// entries are appended independently on different devices; whole-field LWW
// silently dropped one side's appends (see THREAT_MODEL.md). Residual: a
// deletion on one device can be resurrected by a device still carrying the
// entry — accepted, append is the dominant operation.
const UNION_ARRAY_FIELDS = new Set(['discussionLog']);

type Entity = Record<string, unknown>;

/**
 * How far in the future a remote timestamp may lie. Merges are last-writer-wins
 * on the writer's clock and are never corrected on receipt (lib/clock-skew.ts
 * explains why); but a value beyond this can only be a broken clock or a forged
 * row, and left alone it wins every later comparison: an edit stamped 9e15 could
 * never be edited back, nor a delete stamped so be restored.
 */
export const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** A remote row with every timestamp later than `now` + MAX_FUTURE_SKEW_MS brought back to that bound. */
export function capFutureTimestamps<T extends Entity>(row: T, now = Date.now()): T {
  const bound = now + MAX_FUTURE_SKEW_MS;
  const cap = (v: unknown) => (typeof v === 'number' && v > bound ? bound : v);
  const out: Entity = { ...row };
  for (const field of ['createdAt', 'updatedAt', 'deletedAt']) {
    if (field in out) out[field] = cap(out[field]);
  }
  const ft = row.fieldTimestamps;
  if (ft && typeof ft === 'object') {
    out.fieldTimestamps = Object.fromEntries(Object.entries(ft as Record<string, unknown>).map(([k, v]) => [k, cap(v)]));
  }
  return out as T;
}
type FieldTimestamps = Record<string, number>;
type IdEntry = { id: string; at?: number } & Record<string, unknown>;

function isIdEntryArray(value: unknown): value is IdEntry[] {
  return (
    Array.isArray(value) &&
    value.every((e) => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>).id === 'string')
  );
}

/**
 * Union two entry arrays by id. On id collision with differing content the
 * entry from the side with the newer field timestamp wins (ties keep local,
 * matching the per-field LWW convention). Result is ordered oldest-first by
 * `at` (the discussionLog convention), tie-broken by id for determinism.
 */
function unionEntriesById(
  localArr: IdEntry[],
  remoteArr: IdEntry[],
  localTs: number,
  remoteTs: number,
): IdEntry[] {
  const remoteWins = remoteTs > localTs;
  const loser = remoteWins ? localArr : remoteArr;
  const winner = remoteWins ? remoteArr : localArr;
  const byId = new Map<string, IdEntry>();
  for (const e of loser) byId.set(e.id, e);
  for (const e of winner) byId.set(e.id, e); // collisions: winner's version
  return [...byId.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id));
}

/**
 * Create initial fieldTimestamps for a new entity.
 * Stamps every non-excluded key present on the entity.
 */
export function initFieldTimestamps(entity: Entity, now: number): FieldTimestamps {
  const ft: FieldTimestamps = {};
  for (const key of Object.keys(entity)) {
    if (!EXCLUDED_FIELDS.has(key)) {
      ft[key] = now;
    }
  }
  return ft;
}

/**
 * Stamp updated fields. Returns a new fieldTimestamps object with the
 * changed keys set to `now`, preserving existing timestamps for other fields.
 */
export function stampUpdatedFields(
  existingFT: FieldTimestamps | undefined,
  changedKeys: string[],
  now: number,
): FieldTimestamps {
  const ft: FieldTimestamps = { ...(existingFT ?? {}) };
  for (const key of changedKeys) {
    if (!EXCLUDED_FIELDS.has(key)) {
      ft[key] = now;
    }
  }
  return ft;
}

/**
 * Core field-level merge. Compares per-field timestamps and takes the newer
 * value for each field. Returns the merged entity if any changes were applied,
 * or `null` if the local entity is already up-to-date.
 *
 * Falls back to entity-level LWW when either side lacks fieldTimestamps.
 */
export function mergeEntity(
  local: Entity,
  remote: Entity,
  remoteTimestamp: number,
): Entity | null {
  const localFT = local.fieldTimestamps as FieldTimestamps | undefined;
  const remoteFT = remote.fieldTimestamps as FieldTimestamps | undefined;

  // Fallback: entity-level LWW when either side lacks fieldTimestamps
  if (!localFT || !remoteFT) {
    const localUpdatedAt = (local.updatedAt as number) ?? 0;
    if (remoteTimestamp >= localUpdatedAt) {
      const { _enc: _ciphertext, _decryptError: _quarantined, ...row } = remote;
      return row;
    }
    return null;
  }

  // Field-level merge
  const merged: Entity = { ...local };
  const mergedFT: FieldTimestamps = { ...localFT };
  let changed = false;

  // Collect all field keys from both sides (excluding special fields)
  const allKeys = new Set<string>();
  for (const key of Object.keys(local)) {
    if (!EXCLUDED_FIELDS.has(key)) allKeys.add(key);
  }
  for (const key of Object.keys(remote)) {
    if (!EXCLUDED_FIELDS.has(key)) allKeys.add(key);
  }

  for (const key of allKeys) {
    const localTs = localFT[key] ?? 0;
    const remoteTs = remoteFT[key] ?? 0;

    // Union-merged array fields converge regardless of timestamp direction:
    // plain LWW would drop the older side's appends entirely (and an older
    // remote would never contribute its new entries at all). Falls through to
    // LWW when either side is missing/malformed, preserving old semantics.
    if (UNION_ARRAY_FIELDS.has(key) && isIdEntryArray(local[key]) && isIdEntryArray(remote[key])) {
      const union = unionEntriesById(local[key] as IdEntry[], remote[key] as IdEntry[], localTs, remoteTs);
      if (JSON.stringify(union) !== JSON.stringify(local[key])) {
        merged[key] = union;
        mergedFT[key] = Math.max(localTs, remoteTs);
        changed = true;
      }
      continue;
    }

    if (remoteTs > localTs) {
      // Remote wins for this field
      if (key in remote) {
        merged[key] = remote[key];
      } else {
        delete merged[key];
      }
      mergedFT[key] = remoteTs;
      changed = true;
    }
    // Ties and local-newer: keep local (already in merged)
  }

  if (!changed) return null;

  // updatedAt = max of both sides (excluded from field-level comparison)
  const localUpdatedAt = (local.updatedAt as number) ?? 0;
  const remoteUpdatedAt = (remote.updatedAt as number) ?? 0;
  const maxUpdatedAt = Math.max(localUpdatedAt, remoteUpdatedAt);
  merged.updatedAt = maxUpdatedAt;
  mergedFT.updatedAt = maxUpdatedAt;
  merged.fieldTimestamps = mergedFT;

  return merged;
}
