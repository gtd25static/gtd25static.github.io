import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { QrCode } from './QrCode';
import {
  createEnrollOffer, waitForEnrollRequest, sendEnrollSecret, waitForEnrollConsumed, discardEnrollment, sweepEnrollments,
  EnrollError, ENROLL_TTL_MS, type EnrollHost, type EnrollRequest,
} from '../../sync/device-enroll';
import { tokenReach, tokenReachWarning } from '../../sync/github-api';
import { recordError } from '../../lib/diagnostics';

type Phase =
  | { kind: 'starting' }
  | { kind: 'qr'; host: EnrollHost }
  | { kind: 'confirm'; host: EnrollHost; request: EnrollRequest }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; replaceToken?: boolean; blocked?: boolean };

const REPLACE_TOKEN =
  'Whoever saw the QR code has your GitHub token (not your data, which stays encrypted): replace the token on GitHub and save the new one here and on your other devices.';

function describe(err: unknown, sent: boolean): { message: string; replaceToken?: boolean } {
  if (err instanceof EnrollError) {
    if (err.code === 'tampered') return { message: `Someone other than your new device answered this code. Nothing was sent.`, replaceToken: true };
    if (err.code === 'expired') {
      return sent
        ? { message: 'The new device did not confirm that it received the password. If it is not syncing, show a new code.' }
        : { message: 'The code expired. Show a new one to try again.' };
    }
  }
  return { message: 'Could not reach the repository. Check the connection and try again.' };
}

/**
 * The old device's half of a QR enrolment (sync/device-enroll.ts): show the QR,
 * wait for the new device, let the user compare the codes, send the password.
 */
export function EnrollShowDialog({ creds, onClose }: {
  creds: { pat: string; repo: string; password: string };
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const hostRef = useRef<EnrollHost | null>(null);
  const sentRef = useRef(false);

  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    hostRef.current = null;
    sentRef.current = false;
    setPhase({ kind: 'starting' });
    (async () => {
      try {
        // The QR hands this token to whoever sees it: one that reaches beyond the
        // sync repository (e.g. can push to this app's own site) is not shown.
        const warning = tokenReachWarning(await tokenReach(creds.pat));
        if (ac.signal.aborted) return;
        if (warning) {
          setPhase({ kind: 'error', message: `${warning} Replace it before adding a device: the code would hand it out.`, blocked: true });
          return;
        }
        const host = await createEnrollOffer(creds.pat, creds.repo);
        if (ac.signal.aborted) return;
        hostRef.current = host;
        void sweepEnrollments(creds.pat, creds.repo, host.offer.pid);
        setPhase({ kind: 'qr', host });
        const request = await waitForEnrollRequest(host, { signal: ac.signal });
        setPhase({ kind: 'confirm', host, request });
      } catch (err) {
        if (ac.signal.aborted) return;
        if (!(err instanceof EnrollError)) recordError('enroll.show', err);
        setPhase({ kind: 'error', ...describe(err, false) });
      }
    })();
    return () => {
      ac.abort();
      // Left before the password went out: the exchange branch is of no use to
      // anyone. After it went out, the new device still needs it (and deletes it).
      const host = hostRef.current;
      if (host && !sentRef.current) void discardEnrollment(host.offer);
    };
  }, [attempt, creds.pat, creds.repo]);

  async function handleMatch() {
    if (phase.kind !== 'confirm') return;
    const { host, request } = phase;
    const signal = abortRef.current!.signal;
    setPhase({ kind: 'sending' });
    try {
      await sendEnrollSecret(host, request, creds.password);
      sentRef.current = true;
      setPhase({ kind: 'sent' });
      await waitForEnrollConsumed(host, Date.now() + ENROLL_TTL_MS, { signal });
      setPhase({ kind: 'done' });
    } catch (err) {
      if (signal.aborted) return;
      // The new device gave up as well by now (same timeout): tidy up.
      if (sentRef.current) void discardEnrollment(host.offer);
      if (!(err instanceof EnrollError)) recordError('enroll.send', err);
      setPhase({ kind: 'error', ...describe(err, sentRef.current) });
    }
  }

  function handleMismatch() {
    if (phase.kind !== 'confirm') return;
    abortRef.current?.abort();
    void discardEnrollment(phase.host.offer);
    setPhase({ kind: 'error', message: 'Cancelled: nothing was sent.', replaceToken: true });
  }

  return (
    <Modal open onClose={onClose} title="Add a device">
      <div className="space-y-3 text-sm">
        {phase.kind === 'starting' && <p className="text-zinc-500">Preparing a code…</p>}

        {phase.kind === 'qr' && (
          <>
            <p>
              On the new device open <strong>Settings → GitHub Sync → Join with a QR code</strong> and
              scan this code.
            </p>
            <QrCode text={phase.host.qrText} label="Enrolment QR code" />
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Valid once, for 5 minutes. It holds your GitHub token — do not show it to anyone else or take a
              screenshot. Your sync password is not in it: it is sent encrypted after you compare a code.
            </p>
          </>
        )}

        {phase.kind === 'confirm' && (
          <>
            <p>The new device should now show this code:</p>
            <p className="text-center font-mono text-3xl tracking-widest" data-testid="enroll-code">{phase.request.code}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Send the password only if it shows exactly this code. A different code, or none, means
              someone else scanned the QR.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={handleMismatch}>It doesn't match</Button>
              <Button size="sm" onClick={handleMatch}>It matches — send</Button>
            </div>
          </>
        )}

        {phase.kind === 'sending' && <p className="text-zinc-500">Sending…</p>}
        {phase.kind === 'sent' && (
          <p className="text-zinc-500">Sent. Waiting for the new device to receive it — keep this open.</p>
        )}
        {phase.kind === 'done' && (
          <>
            <p>The new device has the password and is downloading your data.</p>
            <div className="flex justify-end"><Button size="sm" onClick={onClose}>Done</Button></div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p role="alert">{phase.message}</p>
            {phase.replaceToken && <p className="text-xs text-amber-700 dark:text-amber-300">{REPLACE_TOKEN}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
              {!phase.blocked && <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Show a new code</Button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
