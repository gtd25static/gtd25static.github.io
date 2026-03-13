import { useMemo } from 'react';
import { useMotivationStats } from './use-motivation-stats';
import { pickMotivationMessage, type MotivationMessage } from '../lib/motivation-messages';

// Seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function useMotivation(): MotivationMessage | null {
  const stats = useMotivationStats();

  // Rotate every 30 minutes
  const seed = useMemo(
    () => Math.floor(Date.now() / (30 * 60 * 1000)),
    [],
  );

  return useMemo(() => {
    if (!stats) return null;
    const rng = mulberry32(seed);
    return pickMotivationMessage(stats, rng);
  }, [stats, seed]);
}
