// Read QR codes from the camera into a <video>. Decoding is jsQR, loaded only
// when a scan starts (it is ~250 KB; BarcodeDetector would be lighter but is
// missing from desktop Chrome on Windows/Linux). Frames never leave the page.

export type CameraErrorCode = 'denied' | 'missing' | 'unavailable';

export class CameraError extends Error {
  code: CameraErrorCode;
  constructor(code: CameraErrorCode, message: string) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

// Frames are scaled down to this width before decoding: a QR filling a third of
// the frame still gets ~4 px per module, and a phone decodes it in tens of ms.
const MAX_DECODE_WIDTH = 800;
const FRAME_INTERVAL_MS = 200;

async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unavailable', 'This browser cannot use the camera here.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CameraError('denied', 'Camera access was denied. Allow it in the browser\'s site settings and try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CameraError('missing', 'No camera was found on this device.');
    }
    throw new CameraError('unavailable', 'The camera could not be started (is another app using it?).');
  }
}

/**
 * Show the camera in `video` and call `onText` with every QR read (the same code
 * repeats while it stays in view). Resolves to a stop function that releases the
 * camera; call it in every exit path.
 */
export async function startQrScanner(video: HTMLVideoElement, onText: (text: string) => void): Promise<() => void> {
  const stream = await openCamera();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', ''); // iOS: inline, not fullscreen
    await video.play();
    const { default: jsQR } = await import('jsqr');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new CameraError('unavailable', 'The camera image could not be read.');
    const tick = () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, MAX_DECODE_WIDTH / video.videoWidth);
        const width = Math.round(video.videoWidth * scale);
        const height = Math.round(video.videoHeight * scale);
        canvas.width = width;
        canvas.height = height;
        ctx.drawImage(video, 0, 0, width, height);
        const found = jsQR(ctx.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' });
        if (found?.data) onText(found.data);
      }
      if (!stopped) timer = setTimeout(tick, FRAME_INTERVAL_MS);
    };
    tick();
    return stop;
  } catch (err) {
    stop();
    throw err instanceof CameraError ? err : new CameraError('unavailable', 'The camera could not be started.');
  }
}
