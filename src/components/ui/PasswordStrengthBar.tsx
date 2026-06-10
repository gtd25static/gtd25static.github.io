import { estimateSecretStrength, formatCrackTime, type SecretKind } from '../../lib/password-strength';

interface Props {
  /** The candidate secret, exactly as the submit gate will check it (trimmed where the gate trims). */
  secret: string;
  kind: SecretKind;
}

const SEGMENTS = 4;

/**
 * Live strength feedback for a secret being chosen. Fills toward the gate's
 * threshold (>1 year average offline crack time per THREAT_MODEL.md); below it,
 * shows one actionable hint + the crack-time estimate; at it, a minimal green check.
 */
export function PasswordStrengthBar({ secret, kind }: Props) {
  if (!secret) return null;
  const est = estimateSecretStrength(secret, kind);
  const color = est.ok ? 'bg-green-500' : est.fraction >= 0.5 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="mt-1.5 space-y-1">
      <div
        className="flex gap-1"
        role="progressbar"
        aria-valuenow={Math.round(est.fraction * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Secret strength"
      >
        {Array.from({ length: SEGMENTS }, (_, i) => {
          const fill = Math.max(0, Math.min(1, est.fraction * SEGMENTS - i));
          return (
            <div key={i} className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${fill * 100}%` }} />
            </div>
          );
        })}
      </div>
      {est.ok ? (
        <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-500">
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 8.5 6.5 12 13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Strong enough
        </p>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {est.hint} Crackable {formatCrackTime(est.crackSeconds)}.
        </p>
      )}
    </div>
  );
}
