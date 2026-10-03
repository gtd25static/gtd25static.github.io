import type JSZip from 'jszip';
import type { JSZipObject } from 'jszip';

// JSZip has internalStream at runtime (zipObject.js) but leaves it out of its typings.
type StreamingEntry = { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };

/**
 * Inflate one ZIP entry, refusing to go past `limit` bytes. The size checks of
 * the backup and sound imports used to run on the INFLATED result, so a small
 * archive that inflates to gigabytes (a zip bomb) ran the tab out of memory
 * before any check. This stops as it inflates, whatever the entry's header
 * claims (a header can lie); a header that already admits too much is refused
 * before inflating anything.
 */
export function inflateWithin(entry: JSZipObject, limit: number, tooLarge: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
  if (typeof declared === 'number' && declared > limit) return Promise.reject(new Error(tooLarge));
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = (entry as unknown as StreamingEntry).internalStream('uint8array');
    stream
      .on('data', (chunk: Uint8Array) => {
        total += chunk.length;
        if (total > limit) {
          stream.pause();
          reject(new Error(tooLarge));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', reject)
      .on('end', () => {
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(out);
      })
      .resume();
  });
}
