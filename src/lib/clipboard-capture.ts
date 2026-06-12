// Classify pasted clipboard content for the Shared Folder's confirm-then-upload
// flow. Pure so the rules are unit-testable without DOM clipboard plumbing.
//
// Rules: files win (a snipping-tool screenshot arrives as an image/* File);
// otherwise text that IS an http(s) URL becomes a link; any other non-empty
// text becomes a snippet — deliberately including text with an embedded URL,
// so the preview shows exactly what will be saved instead of silently
// extracting the link.

import { isValidUrl } from './link-utils';

export type PastePayload =
  | { kind: 'files'; files: File[] }
  | { kind: 'link'; url: string }
  | { kind: 'snippet'; text: string };

export function classifyClipboard(files: File[], text: string): PastePayload | null {
  if (files.length > 0) return { kind: 'files', files };
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (isValidUrl(trimmed)) return { kind: 'link', url: trimmed };
  return { kind: 'snippet', text: trimmed };
}
