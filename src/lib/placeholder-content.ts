import { SENSITIVE_FIELDS } from '../sync/crypto';
import type { DiscussionEntry, TaskLink } from '../db/models';
import { INBOX_LIST_NAME, isInboxList } from './constants';
import { placeholderVocabulary, type PlaceholderVocabulary } from './placeholder-vocabulary';

// Decoy content for the duress unlock (see db/vault-reinit.ts). Given a fully
// decrypted row, produce a same-shaped row with every SENSITIVE text field
// replaced by ordinary to-do content (lib/placeholder-vocabulary.ts: it has to
// pass for someone's real lists — filler text gave the swap away on sight, and
// repeated so often it put duplicate banners everywhere) — while KEEPING every
// id, structural reference,
// order, status and timestamp, so the decoy's structure is byte-identical to
// what a pre-unlock adversary already saw in the plaintext metadata. If the
// structure changed, the decoy would be inconsistent and give itself away.
//
// The security contract (enforced by the test): for every field in
// SENSITIVE_FIELDS, the decoy either REPLACES it or lists it in STRUCTURAL_KEEP
// with a reason — so a sensitive field added later cannot silently leak real
// content through the duress path.

// Kept on EVERY entity: `fieldTimestamps` is merge bookkeeping, not content —
// a map of field name to when it last changed. It became a sensitive field in
// SYNC_VERSION 7 (its keys named the encrypted fields on the wire), but decoying
// it would put lorem where the merge expects numbers and break sync on the decoy
// vault. Keeping it also keeps the decoy consistent with the structure an
// adversary may already have seen.
export const STRUCTURAL_KEEP_ALL = ['fieldTimestamps'];

// Sensitive fields a decoy row must not carry at all: this device's own sync
// bookkeeping (sync/conflicts.ts). A device whose sync was never set up has
// none — kept, it said the opposite; replaced, it became a sentence where a map
// of numbers belongs.
export const PLACEHOLDER_DROP = ['_base', '_pushed'];

// The fields placeholderRow replaces by name (anything else would fall to its
// generic sentence; a test holds every SENSITIVE_FIELDS key to one of the lists).
export const PLACEHOLDER_REPLACED = [
  'title', 'description', 'link', 'url', 'linkTitle', 'links', 'discussionLog', 'savedSearches',
  'name', 'label', 'size', 'mimeType', 'smartColoring',
];

// Sensitive fields deliberately NOT replaced, because they carry no free-text
// personal content — only low-entropy enums / opaque refs / cosmetics — and
// keeping them makes the decoy resolvable and consistent.
export const STRUCTURAL_KEEP: Record<string, string[]> = {
  // A shared item stays the same KIND (link/file/snippet) pointing at its now-
  // dummy blob. Its name/url are decoyed, and its size/type are rewritten to
  // describe that dummy blob: a "5 MB PNG" that opens as a few words of text
  // would give the swap away.
  sharedItem: ['type', 'blobId'],
  // Canvas/node colours and shapes are cosmetic, not content.
  mindmap: ['background'],
  mindmapNode: ['shape', 'palette', 'colorBg', 'colorFg', 'colorBorder'],
};

// --- Deterministic randomness -------------------------------------------------
// From the row id (and field), so the result is stable — a retried swap writes the
// same thing — and tests need no RNG. Never used for anything security-sensitive.

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 over the hash of `seedText`: a stream of numbers in [0, 1). */
function stream(seedText: string): () => number {
  let a = hash(seedText);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rand = () => number;
const pick = <T,>(r: Rand, list: readonly T[]): T => list[Math.floor(r() * list.length)];
const TOKEN_CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'];
const token = (r: Rand, n: number) => Array.from({ length: n }, () => pick(r, TOKEN_CHARS)).join('');
const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const slug = (text: string) => fold(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// --- Context: language, and what has been used where ----------------------------

/**
 * One swap's worth of state: the vocabulary (the browser's language), and the
 * values handed out per scope (a list's tasks, a task's subtasks, a map's nodes…)
 * so nothing repeats inside one. Filler text repeated across a list put a
 * "possible duplicates" banner over it and collapsed equal saved searches.
 */
export interface PlaceholderContext {
  vocab: PlaceholderVocabulary;
  used: Map<string, Set<string>>;
}

export function createPlaceholderContext(language?: string): PlaceholderContext {
  return { vocab: placeholderVocabulary(language), used: new Map() };
}

/** A value from `make` not yet used in `scope`: re-rolled deterministically, then numbered. */
function unique(ctx: PlaceholderContext, scope: string, seedText: string, make: (r: Rand) => string): string {
  let used = ctx.used.get(scope);
  if (!used) ctx.used.set(scope, used = new Set());
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = make(stream(`${seedText}|${attempt}`));
    if (!used.has(fold(value))) {
      used.add(fold(value));
      return value;
    }
  }
  const base = make(stream(seedText));
  let n = 2;
  while (used.has(fold(`${base} ${n}`))) n++;
  used.add(fold(`${base} ${n}`));
  return `${base} ${n}`;
}

// --- Generators ---------------------------------------------------------------

function sentences(r: Rand, v: PlaceholderVocabulary, min: number, max: number): string {
  const count = min + Math.floor(r() * (max - min + 1));
  const out: string[] = [];
  while (out.length < count) {
    const next = pick(r, v.notes);
    if (!out.includes(next)) out.push(next);
  }
  return out.join(' ');
}

/** A link that looks like one: an ordinary site, and the title such a page has. */
function link(r: Rand, v: PlaceholderVocabulary): TaskLink {
  const topic = pick(r, v.topics);
  const person = pick(r, v.people);
  const wiki = v === placeholderVocabulary('es') ? 'es' : 'en';
  switch (Math.floor(r() * 5)) {
    case 0: return { url: `https://${wiki}.wikipedia.org/wiki/${encodeURIComponent(topic.replace(/ /g, '_'))}`, title: `${topic} - Wikipedia` };
    case 1: return { url: `https://github.com/${person}/${slug(topic)}`, title: `${person}/${slug(topic)}` };
    case 2: return { url: `https://www.youtube.com/watch?v=${token(r, 11)}`, title: topic };
    case 3: return { url: `https://docs.google.com/document/d/${token(r, 32)}/edit`, title: topic };
    default: return { url: `https://medium.com/@${person}/${slug(topic)}-${token(r, 10).toLowerCase()}`, title: topic };
  }
}

function placeholderLinks(id: string, links: TaskLink[], v: PlaceholderVocabulary): TaskLink[] {
  return links.map((original, i) => {
    const { url, title } = link(stream(`${id}|links|${i}`), v);
    return original.title !== undefined ? { url, title } : { url };
  });
}

function placeholderDiscussion(id: string, log: DiscussionEntry[], v: PlaceholderVocabulary): DiscussionEntry[] {
  // Keep every entry id + timestamp (structure/metadata); replace the note only.
  return log.map((e, i) => ({ id: e.id, at: e.at, ...(e.note !== undefined ? { note: sentences(stream(`${id}|note|${i}`), v, 1, 2) } : {}) }));
}

type Row = Record<string, unknown>;

/**
 * Replace a decrypted row's sensitive content with placeholder content, keeping
 * structure. `entityType` is the SENSITIVE_FIELDS key (task/subtask/taskList/…).
 * Pass one `ctx` for every row of a swap: it keeps values distinct per scope and
 * the language consistent.
 */
export function placeholderRow(entityType: string, row: Row, ctx: PlaceholderContext = createPlaceholderContext()): Row {
  const fields = SENSITIVE_FIELDS[entityType];
  if (!fields) return { ...row };
  const keep = new Set([...STRUCTURAL_KEEP_ALL, ...(STRUCTURAL_KEEP[entityType] ?? [])]);
  const id = String(row.id ?? '');
  const v = ctx.vocab;
  const out: Row = { ...row };
  // A task's link and its title, a shared link's name and URL: one page, both halves.
  const page = link(stream(`${id}|page`), v);

  for (const field of fields) {
    if (keep.has(field)) continue;      // structural / cosmetic — preserved by design
    if (PLACEHOLDER_DROP.includes(field)) { delete out[field]; continue; }
    if (out[field] == null) continue;    // absent field: nothing to hide

    switch (field) {
      case 'title':
        out[field] = entityType === 'subtask'
          ? unique(ctx, `subtask:${String(row.taskId)}`, `${id}|title`, (r) => `${pick(r, v.steps)}${pick(r, v.when)}`)
          : unique(ctx, `task:${String(row.listId)}`, `${id}|title`, (r) => `${pick(r, v.tasks)}${pick(r, v.when)}`);
        break;
      case 'description':
        out[field] = sentences(stream(`${id}|description`), v, 1, 3);
        break;
      case 'link':
      case 'url':
        out[field] = page.url;
        break;
      case 'linkTitle':
        out[field] = page.title;
        break;
      case 'links':
        out[field] = Array.isArray(out[field]) ? placeholderLinks(id, out[field] as TaskLink[], v) : [];
        break;
      case 'discussionLog':
        out[field] = Array.isArray(out[field]) ? placeholderDiscussion(id, out[field] as DiscussionEntry[], v) : [];
        break;
      case 'savedSearches': {
        // Same number of chips, all distinct (equal ones would collapse on read).
        const count = Array.isArray(out[field]) ? (out[field] as unknown[]).length : 0;
        out[field] = Array.from({ length: count }, (_, i) =>
          unique(ctx, `searches:${id}`, `${id}|search|${i}`, (r) => pick(r, v.searches)));
        break;
      }
      case 'name':
        out[field] = placeholderName(entityType, row, id, page, ctx);
        break;
      case 'label':
        out[field] = row.parentId === undefined
          ? unique(ctx, `node:${String(row.mapId)}`, `${id}|label`, (r) => pick(r, v.maps))
          : unique(ctx, `node:${String(row.mapId)}`, `${id}|label`, (r) => pick(r, v.nodes));
        break;
      case 'size':
        // Only a blob-backed item has bytes to describe; a link's size stays as is.
        if (row.blobId) out[field] = placeholderBlobBytes(String(row.blobId), v).length;
        break;
      case 'mimeType':
        out[field] = 'text/plain'; // what the dummy blob actually is
        break;
      case 'smartColoring':
        out[field] = true; // only ever true or absent: a flag, not content
        break;
      default:
        // Any future text field: an ordinary sentence.
        out[field] = sentences(stream(`${id}|${field}`), v, 1, 1);
    }
  }
  return out;
}

function placeholderName(entityType: string, row: Row, id: string, page: TaskLink, ctx: PlaceholderContext): string {
  const v = ctx.vocab;
  switch (entityType) {
    case 'taskList':
      // The Inbox is found by its name: renamed, it vanished from the sidebar,
      // Focus started picking from it, and the next capture made a new "Inbox".
      // It is the app's own name, not content.
      if (isInboxList(row as { name: string; type: string })) return INBOX_LIST_NAME;
      return unique(ctx, 'taskList', `${id}|name`, (r) => pick(r, v.lists));
    case 'mindmapFolder':
      return unique(ctx, `folder:${String(row.parentId ?? '')}`, `${id}|name`, (r) => pick(r, v.folders));
    case 'mindmap':
      return unique(ctx, 'mindmap', `${id}|name`, (r) => pick(r, v.maps));
    case 'sharedItem':
      if (row.type === 'link') return page.title ?? page.url;
      return unique(ctx, 'sharedItem', `${id}|name`, (r) => `${pick(r, v.files)}.txt`);
    default:
      return capitalised(sentences(stream(`${id}|name`), v, 1, 1));
  }
}

/** Placeholder bytes for a shared blob (replaces real file/snippet content): a short note. */
export function placeholderBlobBytes(id: string, vocab: PlaceholderVocabulary = placeholderVocabulary()): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${sentences(stream(`${id}|blob`), vocab, 2, 4)}\n`);
}

/** The content fields the decoy replaces for an entity type (for the contract test). */
export function placeholderReplacedFields(entityType: string): string[] {
  const fields = SENSITIVE_FIELDS[entityType] ?? [];
  const keep = new Set([...STRUCTURAL_KEEP_ALL, ...(STRUCTURAL_KEEP[entityType] ?? [])]);
  return fields.filter((f) => !keep.has(f));
}
