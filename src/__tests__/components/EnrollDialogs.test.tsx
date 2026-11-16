// @vitest-environment jsdom
//
// The two halves of a QR enrolment as the user drives them. The protocol itself
// is covered in sync/device-enroll.test.ts; here it is mocked, and so is the camera.
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { EnrollOffer, EnrollHost } from '../../sync/device-enroll';

const h = vi.hoisted(() => ({
  onText: null as null | ((text: string) => void),
  startQrScanner: vi.fn(),
  joinRepository: vi.fn(),
  reach: { classicScopes: null as string[] | null, canPushAppSite: false },
}));

vi.mock('../../sync/device-enroll', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/device-enroll')>()),
  createEnrollOffer: vi.fn(),
  waitForEnrollRequest: vi.fn(),
  sendEnrollSecret: vi.fn(),
  waitForEnrollConsumed: vi.fn(),
  discardEnrollment: vi.fn(async () => undefined),
  sweepEnrollments: vi.fn(async () => undefined),
  requestEnrollment: vi.fn(),
  receiveEnrollSecret: vi.fn(),
}));
vi.mock('../../sync/sync-engine', () => ({ joinRepository: h.joinRepository }));
vi.mock('../../lib/qr-scan', () => ({ startQrScanner: h.startQrScanner }));
vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));
vi.mock('../../sync/github-api', () => ({
  tokenReach: vi.fn(async () => h.reach),
  tokenReachWarning: (reach: { canPushAppSite: boolean }) => (reach.canPushAppSite ? 'TOKEN REACHES TOO FAR.' : null),
}));

import * as enroll from '../../sync/device-enroll';
import { EnrollShowDialog } from '../../components/settings/EnrollShowDialog';
import { EnrollScanDialog } from '../../components/settings/EnrollScanDialog';

const PAT = 'github_pat_0123456789abcdefghijklmnop';
const REPO = 'owner/repo';
const PASSWORD = 'the ring password';
const m = vi.mocked(enroll);

let host: EnrollHost;
let offer: EnrollOffer;

beforeEach(async () => {
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof import('../../sync/device-enroll')>('../../sync/device-enroll');
  host = await actual.createEnrollOffer(PAT, REPO);
  offer = host.offer;
  h.onText = null;
  h.reach = { classicScopes: null, canPushAppSite: false };
  h.startQrScanner.mockImplementation(async (_video: HTMLVideoElement, onText: (t: string) => void) => {
    h.onText = onText;
    return vi.fn();
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('EnrollShowDialog (the device that already syncs)', () => {
  const creds = { pat: PAT, repo: REPO, password: PASSWORD };
  const request = { code: '482 913', sha: 'sha-1', peerPub: 'pub', aesKey: {} as CryptoKey };

  it('shows the QR, then the code, and sends the password only once the user confirms it matches', async () => {
    const user = userEvent.setup();
    const arrived = deferred<typeof request>();
    m.createEnrollOffer.mockResolvedValue(host);
    m.waitForEnrollRequest.mockReturnValue(arrived.promise);
    m.sendEnrollSecret.mockResolvedValue();
    m.waitForEnrollConsumed.mockResolvedValue();
    render(<EnrollShowDialog creds={creds} onClose={vi.fn()} />);

    expect(await screen.findByRole('img', { name: 'Enrolment QR code' })).toBeInTheDocument();
    await act(async () => arrived.resolve(request));
    expect(screen.getByTestId('enroll-code')).toHaveTextContent('482 913');
    expect(screen.queryByRole('img', { name: 'Enrolment QR code' })).not.toBeInTheDocument(); // the token leaves the screen
    expect(m.sendEnrollSecret).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'It matches — send' }));
    expect(m.sendEnrollSecret).toHaveBeenCalledWith(host, request, PASSWORD);
    expect(await screen.findByText(/has the password and is downloading/)).toBeInTheDocument();
    // Exchanges that closed tabs left behind are swept, the current one kept.
    expect(m.sweepEnrollments).toHaveBeenCalledWith(PAT, REPO, offer.pid);
  });

  it('shows no code for a token that reaches beyond the sync repository', async () => {
    h.reach = { classicScopes: null, canPushAppSite: true };
    render(<EnrollShowDialog creds={creds} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/TOKEN REACHES TOO FAR.*Replace it/);
    expect(m.createEnrollOffer).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Show a new code' })).not.toBeInTheDocument();
  });

  it('on a mismatch sends nothing, removes the exchange and says to replace the token', async () => {
    const user = userEvent.setup();
    m.createEnrollOffer.mockResolvedValue(host);
    m.waitForEnrollRequest.mockResolvedValue(request);
    render(<EnrollShowDialog creds={creds} onClose={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: "It doesn't match" }));
    expect(m.sendEnrollSecret).not.toHaveBeenCalled();
    expect(m.discardEnrollment).toHaveBeenCalledWith(offer);
    expect(screen.getByText(/replace the token/)).toBeInTheDocument();
  });

  it('closing before sending removes the exchange; closing after leaves it to the new device', async () => {
    const user = userEvent.setup();
    m.createEnrollOffer.mockResolvedValue(host);
    m.waitForEnrollRequest.mockResolvedValue(request);
    const first = render(<EnrollShowDialog creds={creds} onClose={vi.fn()} />);
    await screen.findByTestId('enroll-code');
    first.unmount();
    expect(m.discardEnrollment).toHaveBeenCalledWith(offer);

    m.discardEnrollment.mockClear();
    m.sendEnrollSecret.mockResolvedValue();
    m.waitForEnrollConsumed.mockReturnValue(new Promise(() => {}));
    const second = render(<EnrollShowDialog creds={creds} onClose={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'It matches — send' }));
    await screen.findByText(/keep this open/);
    second.unmount();
    expect(m.discardEnrollment).not.toHaveBeenCalled();
  });
});

describe('EnrollScanDialog (the new device)', () => {
  async function openCamera(user: ReturnType<typeof userEvent.setup>) {
    expect(screen.getByText(/Everything on this device is replaced/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open camera' }));
    await waitFor(() => expect(h.onText).not.toBeNull());
  }

  it('scans, shows the code, receives the password and joins (force pull)', async () => {
    const user = userEvent.setup();
    const received = deferred<string>();
    m.requestEnrollment.mockResolvedValue({ offer, code: '482 913', myPub: 'pub', aesKey: {} as CryptoKey });
    m.receiveEnrollSecret.mockReturnValue(received.promise);
    h.joinRepository.mockResolvedValue({ joined: true });
    render(<EnrollScanDialog replacesSync={false} onClose={vi.fn()} />);
    await openCamera(user);

    act(() => h.onText!('https://not-ours.example'));
    expect(screen.getByText(/not an enrolment code/)).toBeInTheDocument();
    expect(m.requestEnrollment).not.toHaveBeenCalled();

    act(() => h.onText!(host.qrText));
    expect(await screen.findByTestId('enroll-code')).toHaveTextContent('482 913');
    expect(m.requestEnrollment).toHaveBeenCalledWith(offer, expect.any(AbortSignal));

    await act(async () => received.resolve(PASSWORD));
    expect(h.joinRepository).toHaveBeenCalledWith({ pat: PAT, repo: REPO, password: PASSWORD });
    expect(await screen.findByText(/now syncs with/)).toBeInTheDocument();
  });

  it('a join the repository refuses says why', async () => {
    const user = userEvent.setup();
    m.requestEnrollment.mockResolvedValue({ offer, code: '482 913', myPub: 'pub', aesKey: {} as CryptoKey });
    m.receiveEnrollSecret.mockResolvedValue(PASSWORD);
    h.joinRepository.mockResolvedValue({ joined: false, reason: 'The other device has not synced any data yet.' });
    render(<EnrollScanDialog replacesSync={false} onClose={vi.fn()} />);
    await openCamera(user);
    act(() => h.onText!(host.qrText));
    expect(await screen.findByRole('alert')).toHaveTextContent('The other device has not synced any data yet.');
  });

  it('closing while the request is being written withdraws it once written', async () => {
    const user = userEvent.setup();
    const written = deferred<Awaited<ReturnType<typeof enroll.requestEnrollment>>>();
    m.requestEnrollment.mockReturnValue(written.promise);
    const view = render(<EnrollScanDialog replacesSync={false} onClose={vi.fn()} />);
    await openCamera(user);
    act(() => h.onText!(host.qrText));
    await waitFor(() => expect(m.requestEnrollment).toHaveBeenCalled());
    view.unmount();
    await act(async () => written.resolve({ offer, code: '482 913', myPub: 'pub', aesKey: {} as CryptoKey }));
    expect(m.discardEnrollment).toHaveBeenCalledWith(offer);
    expect(m.receiveEnrollSecret).not.toHaveBeenCalled();
  });

  it('a code someone already answered is refused with the reason', async () => {
    const user = userEvent.setup();
    m.requestEnrollment.mockRejectedValue(new enroll.EnrollError('used', 'used'));
    render(<EnrollScanDialog replacesSync onClose={vi.fn()} />);
    expect(screen.getByText(/its current sync settings/)).toBeInTheDocument();
    await openCamera(user);
    act(() => h.onText!(host.qrText));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already used.*replace your GitHub token/);
    expect(h.joinRepository).not.toHaveBeenCalled();
  });

  it('says why the camera did not start', async () => {
    const user = userEvent.setup();
    const err = Object.assign(new Error('Camera access was denied.'), { name: 'CameraError' });
    h.startQrScanner.mockRejectedValue(err);
    render(<EnrollScanDialog replacesSync={false} onClose={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Open camera' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera access was denied.');
  });

  it('closing while waiting for the other device withdraws the request', async () => {
    const user = userEvent.setup();
    m.requestEnrollment.mockResolvedValue({ offer, code: '482 913', myPub: 'pub', aesKey: {} as CryptoKey });
    m.receiveEnrollSecret.mockReturnValue(new Promise(() => {}));
    const view = render(<EnrollScanDialog replacesSync={false} onClose={vi.fn()} />);
    await openCamera(user);
    act(() => h.onText!(host.qrText));
    await screen.findByTestId('enroll-code');
    view.unmount();
    expect(m.discardEnrollment).toHaveBeenCalledWith(offer);
    expect(h.joinRepository).not.toHaveBeenCalled();
  });
});
