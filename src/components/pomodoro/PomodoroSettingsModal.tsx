import { useState, useEffect, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Modal } from '../ui/Modal';
import { usePomodoroStore } from '../../stores/pomodoro-store';
import { db } from '../../db';
import { AMBIENT_SOUNDS, SOUND_CATEGORIES, TICK_SOUND_CODE, BELL_SOUND_CODE } from '../../lib/pomodoro-sounds';
import { importSoundsFromZip, type ImportResult } from '../../db/sound-import';
import { audioEngine } from '../../lib/audio-engine';
import { toast } from '../ui/Toast';
import { newId } from '../../lib/id';
import type { SoundVolumeLevel, SoundPreset } from '../../db/models';

const VOLUME_LEVELS: SoundVolumeLevel[] = ['low', 'medium', 'high'];

export function PomodoroSettingsModal() {
  const open = usePomodoroStore((s) => s.pomodoroSettingsOpen);
  const close = usePomodoroStore((s) => s.setPomodoroSettingsOpen);

  const settings = useLiveQuery(() => db.pomodoroSettings.get('pomodoro'));
  const presets = useLiveQuery(() => db.soundPresets.filter(p => !p.deletedAt).toArray()) ?? [];
  const importedSounds = useLiveQuery(() => db.pomodoroSounds.toArray()) ?? [];
  const importedIds = new Set(importedSounds.map((s) => s.id));

  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [presetName, setPresetName] = useState('');
  const [previewingSound, setPreviewingSound] = useState<string | null>(null);
  const [previewingMix, setPreviewingMix] = useState(false);

  // Current sound levels (from active preset or empty)
  const [soundLevels, setSoundLevels] = useState<Record<string, SoundVolumeLevel>>({});

  // Load sound levels from active preset
  useEffect(() => {
    if (!settings?.activePresetId) {
      setSoundLevels({});
      return;
    }
    db.soundPresets.get(settings.activePresetId).then((preset) => {
      if (preset) setSoundLevels(preset.sounds);
    });
  }, [settings?.activePresetId]);

  // Cleanup previews when modal closes
  const prevOpenRef = useRef(open);
  useEffect(() => {
    if (prevOpenRef.current && !open) {
      audioEngine.stopAllAmbient();
      setPreviewingMix(false);
      setPreviewingSound(null);
    }
    prevOpenRef.current = open;
  }, [open]);

  const updateSettings = useCallback(
    (patch: Record<string, unknown>) => {
      db.pomodoroSettings.update('pomodoro', { ...patch, updatedAt: Date.now() });
    },
    [],
  );

  const cycleSoundLevel = useCallback(
    (code: string) => {
      const current = soundLevels[code] ?? 'off';
      const idx = VOLUME_LEVELS.indexOf(current as SoundVolumeLevel);
      let next: SoundVolumeLevel;
      if (current === 'off' || idx === -1) {
        next = 'low';
      } else if (idx < VOLUME_LEVELS.length - 1) {
        next = VOLUME_LEVELS[idx + 1];
      } else {
        next = 'off';
      }
      const updated = { ...soundLevels, [code]: next };
      if (next === 'off') delete updated[code];
      setSoundLevels(updated);

      // Live preview: update audio engine
      if (next === 'off') {
        audioEngine.stopAmbientSound(code);
      } else {
        audioEngine.setAmbientVolume(code, next);
      }

      // Auto-save to active preset
      if (settings?.activePresetId) {
        db.soundPresets.update(settings.activePresetId, {
          sounds: updated,
          updatedAt: Date.now(),
        });
      }
    },
    [soundLevels, settings?.activePresetId],
  );

  async function handleImportZip() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setImporting(true);
      setImportResult(null);
      try {
        const result = await importSoundsFromZip(file);
        setImportResult(result);
        toast(`Imported ${result.imported.length} sounds`, 'success');
      } catch (err) {
        toast(`Import failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error');
      } finally {
        setImporting(false);
      }
    };
    input.click();
  }

  async function handleSavePreset() {
    const name = presetName.trim();
    if (!name) return;
    const id = newId();
    const now = Date.now();
    await db.soundPresets.put({
      id,
      name,
      sounds: { ...soundLevels },
      createdAt: now,
      updatedAt: now,
    });
    await updateSettings({ activePresetId: id });
    setPresetName('');
    toast('Preset saved', 'success');
  }

  async function handleSelectPreset(id: string) {
    await updateSettings({ activePresetId: id });
  }

  async function handleDeletePreset(id: string) {
    const now = Date.now();
    await db.soundPresets.update(id, { deletedAt: now, updatedAt: now });
    if (settings?.activePresetId === id) {
      await updateSettings({ activePresetId: null });
      setSoundLevels({});
    }
    toast('Preset deleted', 'info');
  }

  function handlePreviewMix() {
    if (previewingMix) {
      audioEngine.stopAllAmbient();
      setPreviewingMix(false);
    } else {
      // Stop individual preview
      if (previewingSound) {
        audioEngine.stopAmbientSound(previewingSound);
        setPreviewingSound(null);
      }
      audioEngine.stopAllAmbient();
      audioEngine.setMasterVolume(settings?.masterVolume ?? 0.7);
      for (const [code, level] of Object.entries(soundLevels)) {
        if (level !== 'off') {
          audioEngine.playAmbientSound(code, level as SoundVolumeLevel);
        }
      }
      setPreviewingMix(true);
    }
  }

  function volumeBadge(level: SoundVolumeLevel | 'off'): string {
    switch (level) {
      case 'low':
        return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400';
      case 'medium':
        return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
      case 'high':
        return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
      default:
        return 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500';
    }
  }

  if (!settings) return null;

  const hasConfiguredSounds = Object.values(soundLevels).some((l) => l !== 'off');

  return (
    <Modal open={open} onClose={() => close(false)} title="Pomodoro Settings">
      <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-4">
        {/* Timer Sounds */}
        <section>
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Timer Sounds</h3>
          <div className="space-y-3">
            <label className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={settings.tickingEnabled}
                onChange={(e) => updateSettings({ tickingEnabled: e.target.checked })}
                className="rounded accent-accent-600"
              />
              Ticking sound
              {!importedIds.has(TICK_SOUND_CODE) && (
                <span className="text-xs text-amber-500">({TICK_SOUND_CODE}.mp3 missing)</span>
              )}
            </label>
            <label className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={settings.bellEnabled}
                onChange={(e) => updateSettings({ bellEnabled: e.target.checked })}
                className="rounded accent-accent-600"
              />
              End bell
              {!importedIds.has(BELL_SOUND_CODE) && (
                <span className="text-xs text-amber-500">({BELL_SOUND_CODE}.mp3 missing)</span>
              )}
            </label>
            <div className="flex items-center gap-3">
              <span className="text-sm text-zinc-600 dark:text-zinc-400 w-20">Volume</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.masterVolume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  updateSettings({ masterVolume: v });
                  audioEngine.setMasterVolume(v);
                }}
                className="flex-1 accent-accent-600"
              />
              <span className="text-xs text-zinc-400 w-8 text-right">
                {Math.round(settings.masterVolume * 100)}%
              </span>
            </div>
          </div>
        </section>

        {/* Background Noises */}
        <section>
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Background Noises</h3>

          {/* Preset selector */}
          {presets.length > 0 && (
            <div className="mb-3 space-y-1">
              <span className="text-xs text-zinc-500 dark:text-zinc-400">Presets</span>
              <div className="flex flex-wrap gap-1.5">
                {presets.map((p: SoundPreset) => (
                  <div key={p.id} className="flex items-center gap-0.5">
                    <button
                      onClick={() => handleSelectPreset(p.id)}
                      className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                        settings.activePresetId === p.id
                          ? 'bg-accent-100 text-accent-700 font-medium dark:bg-accent-900/30 dark:text-accent-400'
                          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {p.name}
                    </button>
                    <button
                      onClick={() => handleDeletePreset(p.id)}
                      className="rounded-full p-0.5 text-zinc-400 hover:text-red-500"
                      title="Delete preset"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M2 2l6 6M8 2l-6 6" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Save preset + Preview */}
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              placeholder="Preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              className="flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
            />
            <button
              onClick={handleSavePreset}
              disabled={!presetName.trim()}
              className="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700 disabled:opacity-50"
            >
              Save
            </button>
            <button
              onClick={handlePreviewMix}
              disabled={!hasConfiguredSounds}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                previewingMix
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-zinc-200 text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600'
              } disabled:opacity-50`}
            >
              {previewingMix ? 'Stop' : 'Preview'}
            </button>
          </div>

          {/* Organic mix toggle */}
          <label className="flex items-center gap-3 text-sm text-zinc-700 dark:text-zinc-300 mb-3">
            <input
              type="checkbox"
              checked={settings.dynamicMixEnabled ?? false}
              onChange={(e) => {
                updateSettings({ dynamicMixEnabled: e.target.checked });
                audioEngine.setDynamicMix(e.target.checked);
              }}
              className="rounded accent-accent-600"
            />
            <span>
              Organic mix
              <span className="block text-[11px] text-zinc-400 dark:text-zinc-500">
                Slowly varies each sound&apos;s volume
              </span>
            </span>
          </label>

          {/* Sound list by category */}
          {SOUND_CATEGORIES.map((category) => (
            <div key={category} className="mb-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
                {category}
              </span>
              <div className="mt-0.5 space-y-0.5">
                {AMBIENT_SOUNDS.filter((s) => s.category === category).map((sound) => {
                  const available = importedIds.has(sound.code);
                  const level = soundLevels[sound.code] ?? 'off';
                  const isPreviewing = previewingSound === sound.code;
                  return (
                    <div
                      key={sound.code}
                      className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                        available
                          ? 'text-zinc-700 dark:text-zinc-300'
                          : 'text-zinc-300 dark:text-zinc-600'
                      }`}
                    >
                      {/* Preview play/stop button */}
                      {available && (
                        <button
                          onClick={() => {
                            // Stop mix preview if active
                            if (previewingMix) {
                              audioEngine.stopAllAmbient();
                              setPreviewingMix(false);
                            }
                            if (isPreviewing) {
                              audioEngine.stopAmbientSound(sound.code);
                              setPreviewingSound(null);
                            } else {
                              if (previewingSound) audioEngine.stopAmbientSound(previewingSound);
                              audioEngine.playAmbientSound(sound.code, 'medium');
                              setPreviewingSound(sound.code);
                            }
                          }}
                          className={`shrink-0 rounded p-0.5 transition-colors ${
                            isPreviewing
                              ? 'text-accent-600 dark:text-accent-400'
                              : 'text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300'
                          }`}
                          title={isPreviewing ? 'Stop preview' : 'Preview sound'}
                        >
                          {isPreviewing ? (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                              <rect x="3" y="3" width="8" height="8" rx="1" />
                            </svg>
                          ) : (
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                              <path d="M4 2.5l8 4.5-8 4.5V2.5z" />
                            </svg>
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => available && cycleSoundLevel(sound.code)}
                        disabled={!available}
                        className={`flex flex-1 items-center justify-between ${
                          available ? 'hover:opacity-80' : 'cursor-not-allowed'
                        }`}
                      >
                        <span>{sound.name}</span>
                        {available ? (
                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${volumeBadge(level)}`}>
                            {level === 'off' ? '--' : level}
                          </span>
                        ) : (
                          <span className="text-[10px] text-amber-400">missing {sound.code}.m4a</span>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

        </section>

        {/* Import */}
        <section>
          <h3 className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">Import Sounds</h3>
          <button
            onClick={handleImportZip}
            disabled={importing}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
          >
            {importing ? 'Importing...' : 'Import from ZIP'}
          </button>
          {importResult && (
            <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
              <p>{importResult.imported.length} sounds imported</p>
              {importResult.missing.length > 0 && (
                <p className="text-amber-500">{importResult.missing.length} sounds still missing</p>
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
