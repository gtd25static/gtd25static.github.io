// Read QR codes from the camera into a <video>. Frames never leave the page.
//
// Two decoders: the browser's own BarcodeDetector where it exists (Chrome on
// Android, macOS, ChromeOS — the platform's barcode engine, far more tolerant of
// blur, glare and small codes), else jsQR, loaded only when a scan starts (it is
// ~130 KB; desktop Chrome on Windows/Linux has no BarcodeDetector).
//
// The camera is asked for 1080p: without a resolution Chrome opens 640×480, where
// a code held at a comfortable distance gets ~2.5 pixels per module — too few for
// jsQR once the image is a little soft, so it was never read.

export type CameraErrorCode = 'denied' | 'missing' | 'unavailable';

export class CameraError extends Error {
  code: CameraErrorCode;
  constructor(code: CameraErrorCode, message: string) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

const FRAME_INTERVAL_MS = 150;
// jsQR works on at most this many pixels a side.
const MAX_DECODE_SIDE = 1080;
// jsQR reads one pixel per module, so sensor noise flips modules: frames are
// tried in turn as they are, slightly blurred (which averages the noise out),
// and whole rather than the centre square the preview aims at (a code held
// off-centre). Measured on filmed-screen frames (tilted, soft, washed out,
// noisy), no single one of these reads them all; the three in turn read nearly
// every frame where the code fills ~40% of a 720p or 1080p picture.
const JSQR_PASSES: ReadonlyArray<{ whole: boolean; filter: string }> = [
  { whole: false, filter: 'none' },
  { whole: false, filter: 'blur(1px)' },
  { whole: true, filter: 'blur(1px)' },
];

type Decode = (video: HTMLVideoElement) => Promise<string | null>;

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorClass {
  new (options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

async function nativeDecoder(): Promise<Decode | null> {
  const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    if (!(await Detector.getSupportedFormats()).includes('qr_code')) return null;
    const detector = new Detector({ formats: ['qr_code'] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

async function jsQrDecoder(): Promise<Decode> {
  const { default: jsQR } = await import('jsqr');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new CameraError('unavailable', 'The camera image could not be read.');
  let frame = 0;
  return async (video) => {
    const pass = JSQR_PASSES[frame++ % JSQR_PASSES.length];
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const side = Math.min(vw, vh);
    const [sx, sy, sw, sh] = pass.whole ? [0, 0, vw, vh] : [(vw - side) / 2, (vh - side) / 2, side, side];
    const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(sw, sh));
    const width = Math.round(sw * scale);
    const height = Math.round(sh * scale);
    canvas.width = width;
    canvas.height = height;
    ctx.filter = pass.filter;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
    return jsQR(ctx.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unavailable', 'This browser cannot use the camera here.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
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
    // Keep refocusing as the code comes closer, where the camera supports it.
    const [track] = stream.getVideoTracks();
    void track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {});
    video.srcObject = stream;
    video.muted = true;
    video.setAttribute('playsinline', ''); // iOS: inline, not fullscreen
    await video.play();
    const decode = (await nativeDecoder()) ?? (await jsQrDecoder());
    const tick = async () => {
      if (stopped) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const text = await decode(video).catch(() => null);
        if (text && !stopped) onText(text);
      }
      if (!stopped) timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
    };
    void tick();
    return stop;
  } catch (err) {
    stop();
    throw err instanceof CameraError ? err : new CameraError('unavailable', 'The camera could not be started.');
  }
}
