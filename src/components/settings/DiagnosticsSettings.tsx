import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import {
  getBuildInfo, detectFeatures, getErrorLog, clearErrorLog, subscribeErrors,
  isStoragePersisted, getStorageEstimate, forceServiceWorkerUpdate,
  type FeatureReport,
} from '../../lib/diagnostics';
import { getVaultSnapshot } from '../../db/vault';

function fmtBytes(n?: number): string {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

const FEATURE_LABELS: Record<keyof FeatureReport, string> = {
  secureContext: 'Secure context (HTTPS)',
  cryptoSubtle: 'Web Crypto (SubtleCrypto)',
  indexedDB: 'IndexedDB',
  webAuthn: 'WebAuthn',
  webAuthnPrfPossible: 'Platform authenticator',
  idleDetector: 'Idle Detection API',
  serviceWorker: 'Service Worker',
  cacheStorage: 'Cache Storage',
  online: 'Online',
};

export function DiagnosticsSettings() {
  const errors = useSyncExternalStore(subscribeErrors, getErrorLog, getErrorLog);
  const build = getBuildInfo();
  const features = detectFeatures();
  const vault = getVaultSnapshot();
  const [persisted, setPersisted] = useState<boolean | 'unknown'>('unknown');
  const [estimate, setEstimate] = useState<{ usage?: number; quota?: number }>({});

  useEffect(() => {
    let active = true;
    void isStoragePersisted().then((p) => { if (active) setPersisted(p); });
    void getStorageEstimate().then((e) => { if (active) setEstimate(e); });
    return () => { active = false; };
  }, []);

  async function copyReport() {
    const report = {
      build,
      features,
      vault: { enabled: vault.enabled, unlocked: vault.unlocked, hasSecurityKey: vault.hasSecurityKey },
      storage: { persisted, ...estimate },
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      errors: errors.map((e) => ({ at: new Date(e.at).toISOString(), context: e.context, message: e.message, stack: e.stack })),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      toast('Diagnostics copied to clipboard', 'success');
    } catch {
      toast('Could not copy — clipboard unavailable', 'error');
    }
  }

  return (
    <div className="space-y-5 text-sm">
      <div className="space-y-1">
        <h3 className="font-medium">Build</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Version <span className="font-mono">{build.version}</span> · commit <span className="font-mono">{build.commit}</span>
        </p>
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={() => void forceServiceWorkerUpdate()}>
            Force update &amp; reload
          </Button>
          <Button size="sm" variant="secondary" onClick={copyReport}>Copy diagnostics</Button>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500">
          If the app looks out of date after a deploy, use “Force update &amp; reload” to clear a stale service worker.
        </p>
      </div>

      <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <h3 className="font-medium">Browser capabilities</h3>
        <ul className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
          {(Object.keys(FEATURE_LABELS) as Array<keyof FeatureReport>).map((k) => (
            <li key={k} className="flex items-center gap-2 text-xs">
              <span aria-hidden>{features[k] ? '✅' : '⚠️'}</span>
              <span className={features[k] ? '' : 'text-amber-600 dark:text-amber-400'}>{FEATURE_LABELS[k]}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <h3 className="font-medium">Storage</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Persisted: <span className="font-mono">{String(persisted)}</span>
          {persisted !== true && ' (browser may evict data under pressure)'}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Using <span className="font-mono">{fmtBytes(estimate.usage)}</span> of <span className="font-mono">{fmtBytes(estimate.quota)}</span>
        </p>
      </div>

      <div className="space-y-1 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <h3 className="font-medium">Paranoid Mode</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {vault.enabled
            ? `Enabled · ${vault.unlocked ? 'unlocked' : 'locked'} · security key ${vault.hasSecurityKey ? 'enrolled' : 'not enrolled'}`
            : 'Disabled'}
        </p>
      </div>

      <div className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-700">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Recent errors ({errors.length})</h3>
          {errors.length > 0 && (
            <button type="button" onClick={() => clearErrorLog()} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
              Clear
            </button>
          )}
        </div>
        {errors.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">No errors captured.</p>
        ) : (
          <ul className="max-h-48 space-y-1 overflow-auto">
            {[...errors].reverse().map((e, i) => (
              <li key={i} className="rounded bg-zinc-50 p-1.5 text-xs dark:bg-zinc-800/60">
                <span className="text-zinc-400">{new Date(e.at).toLocaleTimeString()}</span>{' '}
                <span className="font-mono text-zinc-500">{e.context}</span>
                <div className="text-red-600 dark:text-red-400">{e.message}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
