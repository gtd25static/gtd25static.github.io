import type { SharedItem } from '../../db/models';
import { getSharedBlobBytes } from '../../sync/shared-blobs';

// Beyond this the preview shows only the start: a snippet may be megabytes, and
// laying out all of it in one <pre> would freeze the page. Copy and Download
// still take the whole text.
export const SNIPPET_PREVIEW_CHARS = 100_000;

/** A snippet's text: its blob's bytes as UTF-8 (bad sequences become U+FFFD, never an error). */
export async function loadSnippetText(item: SharedItem): Promise<string> {
  if (!item.blobId) throw new Error('missing blob');
  const bytes = await getSharedBlobBytes(item.blobId, item.size);
  return new TextDecoder().decode(bytes);
}

export function snippetErrorMessage(err: unknown): string {
  return err instanceof Error && err.message === 'NO_SYNC_KEY'
    ? 'Unlock the vault / set up sync to open this item.'
    : 'Could not load this text.';
}
