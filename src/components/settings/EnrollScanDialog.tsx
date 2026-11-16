import { useEffect, useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import {
  parseEnrollQr, requestEnrollment, receiveEnrollSecret, discardEnrollment, EnrollError,
  type EnrollOffer, type EnrollJoin,
} from '../../sync/device-enroll';
import { joinRepository } from '../../sync/sync-engine';
import { startQrScanner } from '../../lib/qr-scan';
import { recordError } from '../../lib/diagnostics';

type Phase =
  | { kind: 'intro' }
  | { kind: 'scanning' }
  | { kind: 'requesting' }
  | { kind: 'code'; code: string }
  | { kind: 'joining' }
  | { kind: 'done'; repo: string }
  | { kind: 'error'; message: string };

const SOMEONE_ELSE =
  'Someone else may have the code: on the other device, replace your GitHub token, then show a new code.';

function describe(err: unknown): string {
  if (err instanceof EnrollError) {
    switch (err.code) {
      case 'used': return `This code was already used. ${SOMEONE_ELSE}`;
      case 'tampered': return `The exchange was interfered with, so nothing was saved. ${SOMEONE_ELSE}`;
      case 'cancelled': return 'The other device cancelled. If it still shows a code, do not confirm it there.';
      case 'expired': return 'The other device did not answer in time. Show a new code there and scan again.';
    }
  }
  if (err instanceof Error && /\b401\b/.test(err.message)) return 'GitHub rejected the token in this code.';
  if (err instanceof Error && /\b404\b/.test(err.message)) return 'The repository in this code was not found.';
  return err instanceof Error && err.name === 'CameraError'
    ? err.message
    : 'Could not reach the repository. Check the connection and try again.';
}

/**
 * The new device's half of a QR enrolment (sync/device-enroll.ts): scan, show
 * the code, receive the password, then take the repository's data (force pull).
 */
export function EnrollScanDialog({ onClose, replacesSync }: { onClose: () => void; replacesSync: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' });
  const [notOurs, setNotOurs] = useState(false);
  const [offer, setOffer] = useState<EnrollOffer | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const joinRef = useRef<EnrollJoin | null>(null);
  const receivedRef = useRef(false);

  // One exchange per dialog: closing it gives up on the request (and removes it,
  // so the old device stops waiting) unless the password already arrived.
  useEffect(() => {
    const ac = new AbortController();
    abortRef.current = ac;
    return () => {
      ac.abort();
      const join = joinRef.current;
      if (join && !receivedRef.current) void discardEnrollment(join.offer);
    };
  }, []);

  const scanning = phase.kind === 'scanning';
  useEffect(() => {
    const video = videoRef.current;
    if (!scanning || !video) return;
    let cancelled = false;
    let handled = false;
    let stop: (() => void) | null = null;
    startQrScanner(video, (text) => {
      if (cancelled || handled) return;
      const scanned = parseEnrollQr(text);
      if (!scanned) { setNotOurs(true); return; }
      handled = true;
      stop?.();
      setPhase({ kind: 'requesting' });
      setOffer(scanned);
    }).then((stopScanner) => {
      if (cancelled || handled) stopScanner();
      else stop = stopScanner;
    }).catch((err) => {
      if (!cancelled) setPhase({ kind: 'error', message: describe(err) });
    });
    return () => { cancelled = true; stop?.(); };
  }, [scanning]);

  // The exchange for a scanned code, then the pull. Not cut short by a re-render:
  // only closing the dialog (the abort above) or scanning again ends it.
  useEffect(() => {
    if (!offer) return;
    const signal = abortRef.current!.signal;
    (async () => {
      try {
        const join = await requestEnrollment(offer, signal);
        joinRef.current = join;
        // Closed while the request was being written: the cleanup ran without it.
        if (signal.aborted) { void discardEnrollment(join.offer); return; }
        setPhase({ kind: 'code', code: join.code });
        const password = await receiveEnrollSecret(join, { signal });
        receivedRef.current = true;
        setPhase({ kind: 'joining' });
        const result = await joinRepository({ pat: offer.pat, repo: offer.repo, password });
        setPhase(result.joined ? { kind: 'done', repo: offer.repo } : { kind: 'error', message: result.reason });
      } catch (err) {
        // Closed mid-request: a request that landed anyway is withdrawn.
        if (signal.aborted) { if (!receivedRef.current) void discardEnrollment(offer); return; }
        if (!(err instanceof EnrollError)) recordError('enroll.join', err);
        setPhase({ kind: 'error', message: describe(err) });
      }
    })();
  }, [offer]);

  function scanAgain() {
    const join = joinRef.current;
    if (join && !receivedRef.current) void discardEnrollment(join.offer);
    joinRef.current = null;
    receivedRef.current = false;
    setOffer(null);
    setNotOurs(false);
    setPhase({ kind: 'scanning' });
  }

  return (
    <Modal open onClose={onClose} title="Join with a QR code">
      <div className="space-y-3 text-sm">
        {phase.kind === 'intro' && (
          <>
            <p>
              On a device that already syncs, open <strong>Settings → GitHub Sync → Add a device</strong> and
              scan the code it shows. Only scan a code shown by one of your own devices: this device will sync
              with the repository it names.
            </p>
            <p className="text-amber-700 dark:text-amber-300">
              Everything on this device is replaced by the data in the repository
              {replacesSync ? ', and its current sync settings by the ones in the code' : ''}. A safety copy is
              kept in Settings → Backups.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
              <Button size="sm" onClick={() => setPhase({ kind: 'scanning' })}>Open camera</Button>
            </div>
          </>
        )}

        {phase.kind === 'scanning' && (
          <>
            <video ref={videoRef} className="aspect-square w-full rounded-md bg-black object-cover" muted playsInline />
            <p className="text-zinc-500">
              {notOurs ? 'That QR code is not an enrolment code from this app.' : 'Point the camera at the code.'}
            </p>
          </>
        )}

        {phase.kind === 'requesting' && <p className="text-zinc-500">Contacting the repository…</p>}

        {phase.kind === 'code' && (
          <>
            <p>
              Joining <strong>{offer?.repo}</strong>. Check that the other device shows this code, and
              confirm there:
            </p>
            <p className="text-center font-mono text-3xl tracking-widest" data-testid="enroll-code">{phase.code}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Waiting for the other device…</p>
          </>
        )}

        {phase.kind === 'joining' && <p className="text-zinc-500">Downloading your data…</p>}

        {phase.kind === 'done' && (
          <>
            <p>This device now syncs with <strong>{phase.repo}</strong> and has its data.</p>
            <div className="flex justify-end"><Button size="sm" onClick={onClose}>Done</Button></div>
          </>
        )}

        {phase.kind === 'error' && (
          <>
            <p role="alert">{phase.message}</p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={onClose}>Close</Button>
              <Button size="sm" onClick={scanAgain}>Scan again</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
