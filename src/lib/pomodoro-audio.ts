import { db } from '../db';
import { audioEngine } from './audio-engine';
import type { SoundVolumeLevel } from '../db/models';

interface StartAmbientOptions {
  stopExisting?: boolean;
}

export async function loadPomodoroSettings() {
  return db.pomodoroSettings.get('pomodoro');
}

export async function startAmbientFromActivePreset({ stopExisting = true }: StartAmbientOptions = {}) {
  const settings = await loadPomodoroSettings();
  if (!settings?.activePresetId) return;
  const preset = await db.soundPresets.get(settings.activePresetId);
  if (!preset || preset.deletedAt) return;

  if (stopExisting) audioEngine.stopAllAmbient();
  audioEngine.setMasterVolume(settings.masterVolume);
  for (const [code, level] of Object.entries(preset.sounds)) {
    if (level !== 'off') {
      await audioEngine.playAmbientSound(code, level as SoundVolumeLevel);
    }
  }
  audioEngine.setDynamicMix(settings.dynamicMixEnabled ?? false);
}
