import { useEffect, useRef } from 'react';
import { usePomodoroStore } from '../stores/pomodoro-store';
import { audioEngine } from '../lib/audio-engine';
import { showTimerNotification, requestNotificationPermission } from '../lib/notifications';
import { TICK_SOUND_CODE, BELL_SOUND_CODE } from '../lib/pomodoro-sounds';
import { db } from '../db';
import type { SoundVolumeLevel } from '../db/models';

async function loadSettings() {
  return db.pomodoroSettings.get('pomodoro');
}

async function startAmbientFromPreset() {
  const settings = await loadSettings();
  if (!settings?.activePresetId) return;
  const preset = await db.soundPresets.get(settings.activePresetId);
  if (!preset) return;

  audioEngine.setMasterVolume(settings.masterVolume);
  for (const [code, level] of Object.entries(preset.sounds)) {
    if (level !== 'off') {
      await audioEngine.playAmbientSound(code, level as SoundVolumeLevel);
    }
  }
}

export function usePomodoroClock() {
  const prevTimerRunning = useRef(false);
  const prevAmbientPlaying = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const state = usePomodoroStore.getState();
      if (!state.timerRunning) return;
      const result = state.tick();
      if (result.completed) {
        handleCompletion();
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // React to timerRunning changes
  useEffect(() => {
    return usePomodoroStore.subscribe((state) => {
      const wasRunning = prevTimerRunning.current;
      const isRunning = state.timerRunning;

      if (!wasRunning && isRunning) {
        // Timer just started
        requestNotificationPermission();
        loadSettings().then((settings) => {
          if (settings?.tickingEnabled) {
            audioEngine.startTicking(TICK_SOUND_CODE);
          }
          audioEngine.setMasterVolume(settings?.masterVolume ?? 0.7);
        });
        // Also start ambient if not already playing
        if (!state.ambientPlaying) {
          usePomodoroStore.setState({ ambientPlaying: true });
        }
      }

      if (wasRunning && !isRunning) {
        // Timer stopped (either manually or completed)
        audioEngine.stopTicking();
      }

      prevTimerRunning.current = isRunning;
    });
  }, []);

  // React to ambientPlaying changes
  useEffect(() => {
    return usePomodoroStore.subscribe((state) => {
      const wasPlaying = prevAmbientPlaying.current;
      const isPlaying = state.ambientPlaying;

      if (!wasPlaying && isPlaying) {
        startAmbientFromPreset();
      }

      if (wasPlaying && !isPlaying) {
        audioEngine.stopAllAmbient();
      }

      prevAmbientPlaying.current = isPlaying;
    });
  }, []);

  // Handle visibility change (catch timer completion when tab was backgrounded)
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        const state = usePomodoroStore.getState();
        if (state.timerRunning) {
          const result = state.tick();
          if (result.completed) {
            handleCompletion();
          }
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
}

async function handleCompletion() {
  audioEngine.stopTicking();
  const settings = await loadSettings();
  if (settings?.bellEnabled) {
    audioEngine.playBell(BELL_SOUND_CODE);
  }
  showTimerNotification();
  // Stop ambient on completion
  usePomodoroStore.setState({ ambientPlaying: false });
}
