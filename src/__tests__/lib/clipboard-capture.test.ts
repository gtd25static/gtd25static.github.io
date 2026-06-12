import { describe, it, expect } from 'vitest';
import { classifyClipboard } from '../../lib/clipboard-capture';

function file(name: string, type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('classifyClipboard', () => {
  it('files win over any text (snipping-tool screenshot case)', () => {
    const shot = file('image.png');
    const result = classifyClipboard([shot], 'https://also-on-clipboard.example');
    expect(result).toEqual({ kind: 'files', files: [shot] });
  });

  it('classifies a pasted http(s) URL as a link, trimming whitespace', () => {
    expect(classifyClipboard([], '  https://example.com/page?q=1 \n')).toEqual({
      kind: 'link',
      url: 'https://example.com/page?q=1',
    });
  });

  it('keeps text with an embedded URL as a snippet (full fidelity)', () => {
    const text = 'check this out https://example.com later';
    expect(classifyClipboard([], text)).toEqual({ kind: 'snippet', text });
  });

  it('classifies plain and multi-line text as a snippet', () => {
    expect(classifyClipboard([], 'meeting notes')).toEqual({ kind: 'snippet', text: 'meeting notes' });
    const multi = 'line one\nhttps://example.com\nline three';
    expect(classifyClipboard([], multi)).toEqual({ kind: 'snippet', text: multi });
  });

  it('rejects non-http(s) schemes as links — they become snippets', () => {
    expect(classifyClipboard([], 'javascript:alert(1)')).toEqual({
      kind: 'snippet',
      text: 'javascript:alert(1)',
    });
  });

  it('returns null for empty or whitespace-only clipboards', () => {
    expect(classifyClipboard([], '')).toBeNull();
    expect(classifyClipboard([], '   \n ')).toBeNull();
  });
});
