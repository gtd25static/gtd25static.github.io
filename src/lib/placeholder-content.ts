import { SENSITIVE_FIELDS } from '../sync/crypto';
import type { DiscussionEntry, TaskLink } from '../db/models';

// Decoy content for the duress unlock (see db/duress.ts). Given a fully
// decrypted row, produce a same-shaped row with every SENSITIVE text field
// replaced by innocuous lorem — while KEEPING every id, structural reference,
// order, status and timestamp, so the decoy's structure is byte-identical to
// what a pre-unlock adversary already saw in the plaintext metadata. If the
// structure changed, the decoy would be inconsistent and give itself away.
//
// The security contract (enforced by the test): for every field in
// SENSITIVE_FIELDS, the decoy either REPLACES it or lists it in STRUCTURAL_KEEP
// with a reason — so a sensitive field added later cannot silently leak real
// content through the duress path.

// Sensitive fields deliberately NOT replaced, because they carry no free-text
// personal content — only low-entropy enums / opaque refs / cosmetics — and
// keeping them makes the decoy resolvable and consistent.
export const STRUCTURAL_KEEP: Record<string, string[]> = {
  // A shared item stays the same KIND (link/file/snippet) pointing at its now-
  // dummy blob; only its human-readable name/url are decoyed.
  sharedItem: ['type', 'size', 'blobId', 'mimeType'],
  // Canvas/node colours and shapes are cosmetic, not content.
  mindmap: ['background'],
  mindmapNode: ['shape', 'palette', 'colorBg', 'colorFg', 'colorBorder'],
};

const LOREM = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'labore', 'magna', 'aliqua',
  'enim', 'minim', 'veniam', 'quis', 'nostrud', 'ullamco', 'laboris', 'nisi',
];

// Deterministic pseudo-randomness from the row id, so the decoy is stable and
// tests need no RNG. Never used for anything security-sensitive.
function seed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function loremWords(id: string, salt: number, min: number, max: number): string {
  const s = (seed(id) ^ (Math.imul(salt, 2654435761) >>> 0)) >>> 0; // keep unsigned
  const count = min + (s % (max - min + 1));
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(LOREM[(s + i * 7) % LOREM.length]);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function placeholderUrl(id: string, salt: number): string {
  return `https://example.com/${((seed(id) ^ (salt >>> 0)) >>> 0).toString(36)}`;
}

function placeholderLinks(id: string, links: TaskLink[]): TaskLink[] {
  return links.map((_, i) => ({ url: placeholderUrl(id, i + 1), title: loremWords(id, 100 + i, 1, 3) }));
}

function placeholderDiscussion(id: string, log: DiscussionEntry[]): DiscussionEntry[] {
  // Keep every entry id + timestamp (structure/metadata); replace the note only.
  return log.map((e, i) => ({ id: e.id, at: e.at, ...(e.note !== undefined ? { note: loremWords(id, 200 + i, 4, 12) } : {}) }));
}

type Row = Record<string, unknown>;

/**
 * Replace a decrypted row's sensitive content with decoy, keeping structure.
 * `entityType` is the SENSITIVE_FIELDS key (task/subtask/taskList/…).
 */
export function placeholderRow(entityType: string, row: Row): Row {
  const fields = SENSITIVE_FIELDS[entityType];
  if (!fields) return { ...row };
  const keep = new Set(STRUCTURAL_KEEP[entityType] ?? []);
  const id = String(row.id ?? '');
  const out: Row = { ...row };

  for (const field of fields) {
    if (keep.has(field)) continue;      // structural / cosmetic — preserved by design
    if (out[field] == null) continue;    // absent field: nothing to hide

    switch (field) {
      case 'description':
        out[field] = loremWords(id, 1, 6, 16);
        break;
      case 'link':
      case 'url':
        out[field] = placeholderUrl(id, field === 'url' ? 9 : 2);
        break;
      case 'links':
        out[field] = Array.isArray(out[field]) ? placeholderLinks(id, out[field] as TaskLink[]) : out[field];
        break;
      case 'discussionLog':
        out[field] = Array.isArray(out[field]) ? placeholderDiscussion(id, out[field] as DiscussionEntry[]) : out[field];
        break;
      default:
        // title / name / label / linkTitle and any future text field → short lorem
        out[field] = loremWords(id, field.length, 1, 4);
    }
  }
  return out;
}

/** Dummy bytes for a decoy shared blob (replaces real file/snippet content). */
export function placeholderBlobBytes(id: string): Uint8Array {
  return new TextEncoder().encode(loremWords(id, 42, 20, 60));
}

/** The content fields the decoy replaces for an entity type (for the contract test). */
export function placeholderReplacedFields(entityType: string): string[] {
  const fields = SENSITIVE_FIELDS[entityType] ?? [];
  const keep = new Set(STRUCTURAL_KEEP[entityType] ?? []);
  return fields.filter((f) => !keep.has(f));
}
