/**
 * Field-level timestamps for sync conflict resolution.
 *
 * Instead of entity-level last-write-wins, each field tracks when it was last
 * modified. During merge, the newer value for each field wins independently.
 */

const EXCLUDED_FIELDS = new Set(['id', 'createdAt', 'fieldTimestamps']);

type Entity = Record<string, unknown>;
type FieldTimestamps = Record<string, number>;

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
      return remote;
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

  // updatedAt = max of both sides
  const localUpdatedAt = (local.updatedAt as number) ?? 0;
  const remoteUpdatedAt = (remote.updatedAt as number) ?? 0;
  merged.updatedAt = Math.max(localUpdatedAt, remoteUpdatedAt);
  merged.fieldTimestamps = mergedFT;

  return merged;
}
