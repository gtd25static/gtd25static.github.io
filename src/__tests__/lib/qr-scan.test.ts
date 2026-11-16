// @vitest-environment jsdom
//
// The camera side of the QR scanner (the decoding itself is exercised end to end
// in e2e/device-enroll.spec.ts): which camera it asks for, which decoder it uses,
// and that every way out releases the camera.
import { startQrScanner, CameraError } from '../../lib/qr-scan';

function fakeCamera() {
  const track = { stop: vi.fn(), applyConstraints: vi.fn(async () => undefined) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
  const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints) => stream);
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  return { track, getUserMedia };
}

function fakeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.play = vi.fn(async () => undefined);
  Object.defineProperty(video, 'readyState', { value: 4 });
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });
  return video;
}

function installBarcodeDetector(formats: string[], rawValue: string | null) {
  const detect = vi.fn(async () => (rawValue === null ? [] : [{ rawValue }]));
  (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector = class {
    static getSupportedFormats = async () => formats;
    detect = detect;
  };
  return detect;
}

afterEach(() => {
  delete (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
});

describe('startQrScanner', () => {
  it('asks for the back camera at 1080p (640×480, the default, is too coarse to read the code)', async () => {
    const { getUserMedia } = fakeCamera();
    installBarcodeDetector(['qr_code'], null);
    const stop = await startQrScanner(fakeVideo(), vi.fn());
    expect(getUserMedia.mock.calls[0][0]).toMatchObject({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    stop();
  });

  it('reads with the platform\'s barcode detector where there is one, and stop() releases the camera', async () => {
    const { track } = fakeCamera();
    const detect = installBarcodeDetector(['ean_13', 'qr_code'], 'gtd25-enroll:1:{}');
    const onText = vi.fn();
    const video = fakeVideo();
    const stop = await startQrScanner(video, onText);

    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith('gtd25-enroll:1:{}'));
    expect(detect).toHaveBeenCalledWith(video);
    expect(track.applyConstraints).toHaveBeenCalled(); // continuous focus, best effort

    stop();
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    const calls = detect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(detect.mock.calls.length).toBeLessThanOrEqual(calls + 1); // no more frames after stop
  });

  it('falls back to jsQR when the detector cannot read QR codes — and releases the camera if that fails too', async () => {
    const { track } = fakeCamera();
    installBarcodeDetector(['ean_13'], 'never');
    // jsdom has no 2D canvas: the jsQR path cannot read frames here.
    await expect(startQrScanner(fakeVideo(), vi.fn())).rejects.toMatchObject({ name: 'CameraError', code: 'unavailable' });
    expect(track.stop).toHaveBeenCalled();
  });

  it('says the camera was denied', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => { throw new DOMException('no', 'NotAllowedError'); }) },
      configurable: true,
    });
    const err = await startQrScanner(fakeVideo(), vi.fn()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).code).toBe('denied');
  });
});
