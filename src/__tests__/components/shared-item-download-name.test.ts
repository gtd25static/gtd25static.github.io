import { downloadName } from '../../components/shared-folder/SharedItemCard';
import type { SharedItem } from '../../db/models';

function item(overrides: Partial<SharedItem>): SharedItem {
  return {
    id: 'x', type: 'file', name: 'f', size: 1, order: 0, createdAt: 0, updatedAt: 0,
    ...overrides,
  };
}

describe('downloadName', () => {
  it('keeps an existing extension as-is', () => {
    expect(downloadName(item({ name: 'report.pdf', mimeType: 'application/pdf' }))).toBe('report.pdf');
    expect(downloadName(item({ name: 'archive.tar.gz', mimeType: 'application/gzip' }))).toBe('archive.tar.gz');
  });

  it('appends an extension inferred from the MIME type when missing', () => {
    expect(downloadName(item({ name: 'report', mimeType: 'application/pdf' }))).toBe('report.pdf');
    expect(downloadName(item({ name: 'Snippet', mimeType: 'text/plain' }))).toBe('Snippet.txt');
    expect(downloadName(item({ name: 'photo', mimeType: 'image/jpeg' }))).toBe('photo.jpg');
  });

  it('leaves the name unchanged when the MIME type is unknown', () => {
    expect(downloadName(item({ name: 'blob', mimeType: 'application/x-weird' }))).toBe('blob');
    expect(downloadName(item({ name: 'blob', mimeType: undefined }))).toBe('blob');
  });

  it('falls back to "download" for an empty name', () => {
    expect(downloadName(item({ name: '   ', mimeType: 'text/plain' }))).toBe('download.txt');
  });
});
