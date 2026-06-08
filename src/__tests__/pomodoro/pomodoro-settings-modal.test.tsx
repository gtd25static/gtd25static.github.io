// @vitest-environment jsdom
import { vi } from 'vitest';

const audioEngineMock = vi.hoisted(() => ({
  getDynamicMixDebug: vi.fn(() => false),
  setDynamicMixDebug: vi.fn(),
  stopAllAmbient: vi.fn(),
  stopAmbientSound: vi.fn(),
  setAmbientVolume: vi.fn(),
  setMasterVolume: vi.fn(),
  setDynamicMix: vi.fn(),
  playAmbientSound: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/audio-engine', () => ({ audioEngine: audioEngineMock }));

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { PomodoroSettingsModal } from '../../components/pomodoro/PomodoroSettingsModal';
import { usePomodoroStore } from '../../stores/pomodoro-store';

function resetPomodoroStore() {
  usePomodoroStore.setState({
    timerRunning: false,
    timerEndTime: null,
    displaySeconds: 0,
    ambientPlaying: false,
    pomodoroSettingsOpen: false,
  });
}

describe('PomodoroSettingsModal', () => {
  beforeEach(async () => {
    await resetDb();
    resetPomodoroStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    resetPomodoroStore();
  });

  it('does not stop live ambient playback when closing without a preview', async () => {
    const user = userEvent.setup();
    usePomodoroStore.setState({ ambientPlaying: true, pomodoroSettingsOpen: true });

    render(<PomodoroSettingsModal />);

    await screen.findByText('Pomodoro Settings');
    await user.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(screen.queryByText('Pomodoro Settings')).not.toBeInTheDocument());
    expect(audioEngineMock.stopAllAmbient).not.toHaveBeenCalled();
    expect(audioEngineMock.playAmbientSound).not.toHaveBeenCalled();
    expect(usePomodoroStore.getState().ambientPlaying).toBe(true);
  });

  it('restores the active preset after closing a mix preview while ambient is active', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await db.soundPresets.put({
      id: 'focus',
      name: 'Focus',
      sounds: { aa: 'low' },
      createdAt: now,
      updatedAt: now,
    });
    await db.pomodoroSettings.update('pomodoro', {
      activePresetId: 'focus',
      masterVolume: 0.5,
      dynamicMixEnabled: true,
      updatedAt: now,
    });
    usePomodoroStore.setState({ ambientPlaying: true, pomodoroSettingsOpen: true });

    render(<PomodoroSettingsModal />);

    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(audioEngineMock.stopAllAmbient).toHaveBeenCalledTimes(1);

    audioEngineMock.stopAllAmbient.mockClear();
    audioEngineMock.setMasterVolume.mockClear();
    audioEngineMock.setDynamicMix.mockClear();
    audioEngineMock.playAmbientSound.mockClear();

    await user.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(audioEngineMock.playAmbientSound).toHaveBeenCalledWith('aa', 'low'));
    expect(audioEngineMock.stopAllAmbient).toHaveBeenCalledTimes(1);
    expect(audioEngineMock.setMasterVolume).toHaveBeenCalledWith(0.5);
    expect(audioEngineMock.setDynamicMix).toHaveBeenCalledWith(true);
    expect(usePomodoroStore.getState().ambientPlaying).toBe(true);
  });

  it('restores the active preset when stopping a mix preview while ambient is active', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await db.soundPresets.put({
      id: 'focus',
      name: 'Focus',
      sounds: { aa: 'high' },
      createdAt: now,
      updatedAt: now,
    });
    await db.pomodoroSettings.update('pomodoro', {
      activePresetId: 'focus',
      masterVolume: 0.4,
      dynamicMixEnabled: false,
      updatedAt: now,
    });
    usePomodoroStore.setState({ ambientPlaying: true, pomodoroSettingsOpen: true });

    render(<PomodoroSettingsModal />);

    const previewButton = await screen.findByRole('button', { name: 'Preview' });
    await user.click(previewButton);
    audioEngineMock.stopAllAmbient.mockClear();
    audioEngineMock.playAmbientSound.mockClear();

    await user.click(await screen.findByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(audioEngineMock.playAmbientSound).toHaveBeenCalledWith('aa', 'high'));
    expect(audioEngineMock.stopAllAmbient).toHaveBeenCalledTimes(1);
    expect(usePomodoroStore.getState().ambientPlaying).toBe(true);
  });

  it('restores the active preset if the modal unmounts during a preview', async () => {
    const user = userEvent.setup();
    const now = Date.now();
    await db.soundPresets.put({
      id: 'focus',
      name: 'Focus',
      sounds: { aa: 'medium' },
      createdAt: now,
      updatedAt: now,
    });
    await db.pomodoroSettings.update('pomodoro', {
      activePresetId: 'focus',
      masterVolume: 0.7,
      dynamicMixEnabled: false,
      updatedAt: now,
    });
    usePomodoroStore.setState({ ambientPlaying: true, pomodoroSettingsOpen: true });

    const { unmount } = render(<PomodoroSettingsModal />);

    await user.click(await screen.findByRole('button', { name: 'Preview' }));
    audioEngineMock.stopAllAmbient.mockClear();
    audioEngineMock.playAmbientSound.mockClear();

    unmount();

    await waitFor(() => expect(audioEngineMock.playAmbientSound).toHaveBeenCalledWith('aa', 'medium'));
    expect(audioEngineMock.stopAllAmbient).toHaveBeenCalledTimes(1);
    expect(usePomodoroStore.getState().ambientPlaying).toBe(true);
  });
});
