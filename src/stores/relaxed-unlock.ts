import { create } from 'zustand';

// Live "Relaxed unlock" state, written by the engine hook (use-relaxed-unlock) and
// read by App.tsx's screen-lock grace getter and the Security settings readout.
// `multiplier` is 1.0 (neutral) whenever the feature is off or the engine is idle.
interface RelaxedUnlockState {
  multiplier: number;       // ×1.0 .. ×2.0
  effectiveGraceMs: number; // screen-lock grace after the multiplier (0 if grace off)
  set: (next: { multiplier: number; effectiveGraceMs: number }) => void;
  reset: () => void;
}

export const useRelaxedUnlockStore = create<RelaxedUnlockState>((set) => ({
  multiplier: 1,
  effectiveGraceMs: 0,
  set: (next) => set(next),
  reset: () => set({ multiplier: 1, effectiveGraceMs: 0 }),
}));
