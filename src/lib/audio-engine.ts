import { db } from '../db';
import { VOLUME_MULTIPLIERS } from './pomodoro-sounds';
import type { SoundVolumeLevel } from '../db/models';

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private bufferCache = new Map<string, AudioBuffer>();
  private activeSources = new Map<string, ActiveSource>();
  private tickingSource: ActiveSource | null = null;

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
    // Stop existing instance of this sound
    this.stopAmbientSound(code);

    const volume = VOLUME_MULTIPLIERS[volumeLevel] ?? 0;
    if (volume === 0) return;

    const buffer = await this.loadBuffer(code);
    if (!buffer) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = volume;

    source.connect(gain);
    gain.connect(this.getMasterGain());
    source.start();

    this.activeSources.set(code, { source, gain });
  }

  stopAmbientSound(code: string): void {
    const active = this.activeSources.get(code);
    if (active) {
      active.source.stop();
      active.source.disconnect();
      active.gain.disconnect();
      this.activeSources.delete(code);
    }
  }

  stopAllAmbient(): void {
    for (const code of [...this.activeSources.keys()]) {
      this.stopAmbientSound(code);
    }
  }

  setAmbientVolume(code: string, volumeLevel: SoundVolumeLevel): void {
    const volume = VOLUME_MULTIPLIERS[volumeLevel] ?? 0;
    const active = this.activeSources.get(code);
    if (active) {
      if (volume === 0) {
        this.stopAmbientSound(code);
      } else {
        active.gain.gain.value = volume;
      }
    }
  }

  setMasterVolume(volume: number): void {
    const gain = this.getMasterGain();
    gain.gain.value = Math.max(0, Math.min(1, volume));
  }

  async startTicking(code: string): Promise<void> {
    this.stopTicking();

    const buffer = await this.loadBuffer(code);
    if (!buffer) return;

    const ctx = this.ensureContext();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 1.0;

    source.connect(gain);
    gain.connect(this.getMasterGain());
    source.start();

    this.tickingSource = { source, gain };
  }

  stopTicking(): void {
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
}

export const audioEngine = new AudioEngine();
