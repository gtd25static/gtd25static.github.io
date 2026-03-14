import { db } from '../db';
import { VOLUME_MULTIPLIERS } from './pomodoro-sounds';
import type { SoundVolumeLevel } from '../db/models';

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  baseVolume: number;
}

interface DynamicTrackState {
  target: number;
  current: number;
  nextChangeAt: number;
  active: boolean;
  nextReevalAt: number;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private activeSources = new Map<string, ActiveSource>();
  private tickingSource: ActiveSource | null = null;

  // Generation counters to prevent stale async callbacks (fix: race on stop during load)
  private tickingGeneration = 0;
  private ambientGeneration = new Map<string, number>();

  // Dynamic mix state
  private dynamicMixEnabled = false;
  private dynamicMixInterval: ReturnType<typeof setInterval> | null = null;
  private dynamicTargets = new Map<string, DynamicTrackState>();

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  private getMasterGain(): GainNode {
    this.ensureContext();
    return this.masterGain!;
  }

  private async loadBuffer(code: string): Promise<AudioBuffer | null> {
    const cached = this.bufferCache.get(code);
    if (cached) return cached;

    const record = await db.pomodoroSounds.get(code);
    if (!record) return null;

    const ctx = this.ensureContext();
    const arrayBuffer = await record.blob.arrayBuffer();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    this.bufferCache.set(code, buffer);
    return buffer;
  }

  async playAmbientSound(code: string, volumeLevel: SoundVolumeLevel): Promise<void> {
    this.stopAmbientSound(code);

    const volume = VOLUME_MULTIPLIERS[volumeLevel] ?? 0;
    if (volume === 0) return;

    const gen = this.nextAmbientGeneration(code);

    const buffer = await this.loadBuffer(code);
    if (!buffer) return;

    // Abort if stop was called during the async load
    if (gen !== (this.ambientGeneration.get(code) ?? 0)) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    const dynamicState = this.dynamicTargets.get(code);
    const multiplier = this.dynamicMixEnabled && dynamicState ? dynamicState.current : 1.0;
    gain.gain.value = volume * multiplier;

    source.connect(gain);
    gain.connect(this.getMasterGain());
    source.start();

    this.activeSources.set(code, { source, gain, baseVolume: volume });
  }

  stopAmbientSound(code: string): void {
    this.incrementAmbientGeneration(code);

    const active = this.activeSources.get(code);
    if (active) {
      active.source.stop();
      active.source.disconnect();
      active.gain.disconnect();
      this.activeSources.delete(code);
    }
    this.dynamicTargets.delete(code);
  }

  stopAllAmbient(): void {
    // Invalidate all in-flight ambient plays (including those still loading)
    for (const code of this.ambientGeneration.keys()) {
      this.incrementAmbientGeneration(code);
    }
    for (const [, active] of this.activeSources) {
      active.source.stop();
      active.source.disconnect();
      active.gain.disconnect();
    }
    this.activeSources.clear();
    this.dynamicTargets.clear();
    this.stopDynamicMixLoop();
  }

  stopAll(): void {
    this.stopTicking();
    this.stopAllAmbient();
  }

  setAmbientVolume(code: string, volumeLevel: SoundVolumeLevel): void {
    const volume = VOLUME_MULTIPLIERS[volumeLevel] ?? 0;
    const active = this.activeSources.get(code);
    if (active) {
      if (volume === 0) {
        this.stopAmbientSound(code);
      } else {
        active.baseVolume = volume;
        const dynamicState = this.dynamicTargets.get(code);
        const multiplier = this.dynamicMixEnabled && dynamicState ? dynamicState.current : 1.0;
        active.gain.gain.value = volume * multiplier;
      }
    }
  }

  setMasterVolume(volume: number): void {
    const gain = this.getMasterGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  async startTicking(code: string): Promise<void> {
    this.stopTicking();

    const gen = ++this.tickingGeneration;

    const buffer = await this.loadBuffer(code);
    if (!buffer) return;

    // Abort if stop was called during the async load
    if (gen !== this.tickingGeneration) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    source.connect(gain);
    gain.connect(this.getMasterGain());
    source.start();

    this.tickingSource = { source, gain, baseVolume: 1.0 };
  }

  stopTicking(): void {
    this.tickingGeneration++;

    if (this.tickingSource) {
      this.tickingSource.source.stop();
      this.tickingSource.source.disconnect();
      this.tickingSource.gain.disconnect();
      this.tickingSource = null;
    }
  }

  async playBell(code: string): Promise<void> {
    const buffer = await this.loadBuffer(code);
    if (!buffer) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = false;

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    source.connect(gain);
    gain.connect(this.getMasterGain());
    source.start();
  }

  // --- Dynamic mix ---

  setDynamicMix(enabled: boolean): void {
    if (enabled === this.dynamicMixEnabled) return;
    this.dynamicMixEnabled = enabled;

    if (enabled) {
      this.dynamicMixInterval = setInterval(() => this.updateDynamicMix(), 100);
    } else {
      this.stopDynamicMixLoop();
      // Reset all gains to baseVolume
      for (const [, active] of this.activeSources) {
        active.gain.gain.value = active.baseVolume;
      }
      this.dynamicTargets.clear();
    }
  }

  private stopDynamicMixLoop(): void {
    if (this.dynamicMixInterval !== null) {
      clearInterval(this.dynamicMixInterval);
      this.dynamicMixInterval = null;
    }
    this.dynamicMixEnabled = false;
  }

  private updateDynamicMix(): void {
    const now = Date.now();

    for (const [code, active] of this.activeSources) {
      let state = this.dynamicTargets.get(code);
      if (!state) {
        state = {
          target: 1.0,
          current: 1.0,
          nextChangeAt: now + 30_000 + Math.random() * 90_000,
          active: false,
          nextReevalAt: now + Math.random() * 60_000,
        };
        this.dynamicTargets.set(code, state);
      }

      // Re-evaluate whether this track should be actively varying
      if (now >= state.nextReevalAt) {
        if (state.active) {
          // 50/50 chance to deactivate
          if (Math.random() < 0.5) {
            state.active = false;
            state.target = 1.0; // drift back to full
            state.nextReevalAt = now + 120_000 + Math.random() * 60_000;
            console.log(`[organic] ${code}: DEACTIVATED — drifting back to 1.0`);
          } else {
            state.nextReevalAt = now + 60_000 + Math.random() * 120_000;
            console.log(`[organic] ${code}: staying active`);
          }
        } else {
          // Always activate (guarantees every track eventually varies)
          state.active = true;
          state.nextReevalAt = now + 60_000 + Math.random() * 120_000;
          console.log(`[organic] ${code}: ACTIVATED`);
        }
      }

      // Only vary tracks where active === true
      if (state.active && now >= state.nextChangeAt) {
        const newTarget = 0.05 + Math.random() * 0.95;
        console.log(`[organic] ${code}: new target ${state.target.toFixed(3)} → ${newTarget.toFixed(3)}`);
        state.target = newTarget;
        state.nextChangeAt = now + 30_000 + Math.random() * 90_000;
      }

      // Interpolate current toward target
      const diff = state.target - state.current;
      const prev = state.current;
      if (Math.abs(diff) > 0.001) {
        state.current += Math.sign(diff) * Math.min(Math.abs(diff), 0.002);
      } else {
        state.current = state.target;
      }

      const finalVol = active.baseVolume * state.current;
      if (Math.abs(state.current - prev) > 0.001) {
        console.log(`[organic] ${code}: multiplier ${prev.toFixed(3)} → ${state.current.toFixed(3)} (target ${state.target.toFixed(3)}, base ${active.baseVolume.toFixed(3)}, final ${finalVol.toFixed(3)}, active=${state.active})`);
      }
      active.gain.gain.value = finalVol;
    }
  }

  // --- Generation counter helpers ---

  private nextAmbientGeneration(code: string): number {
    const gen = (this.ambientGeneration.get(code) ?? 0) + 1;
    this.ambientGeneration.set(code, gen);
    return gen;
  }

  private incrementAmbientGeneration(code: string): void {
    this.ambientGeneration.set(code, (this.ambientGeneration.get(code) ?? 0) + 1);
  }
}

export const audioEngine = new AudioEngine();
