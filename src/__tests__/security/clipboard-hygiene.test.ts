// @vitest-environment jsdom
//
// The DB and the Paranoid flag are mocked (not the real fake-indexeddb): its
// internal timers deadlock against vi.useFakeTimers(), and here we only care
// about the scheduling logic, which reads one settings row.
let localRow: Record<string, unknown> = {};
let paranoidOn = true;

vi.mock('../../db', () => ({
  db: { localSettings: { get: async () => localRow } },
}));
vi.mock('../../db/vault', () => ({ isParanoidEnabled: () => paranoidOn }));
vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));

import {
  writeTextWithHygiene,
  writeClipboardItemWithHygiene,
  clampClipboardClearSeconds,
  DEFAULT_CLIPBOARD_CLEAR_SECONDS,
  __resetClipboardHygieneForTests,
} from '../../lib/clipboard-hygiene';

let clipboardText = '';
let readGranted = false;
let focused = true;

const writeText = vi.fn(async (t: string) => { clipboardText = t; });
const write = vi.fn(async () => {});
const readText = vi.fn(async () => clipboardText);

function setLocal(patch: Record<string, unknown>) {
  localRow = { id: 'local', syncEnabled: false, syncIntervalMs: 300_000, ...patch };
}

beforeEach(() => {
  __resetClipboardHygieneForTests();
  vi.useFakeTimers();
  vi.clearAllMocks();
  localRow = {};
  clipboardText = '';
  readGranted = false;
  focused = true;
  paranoidOn = true;

  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText, write, readText },
  });
  Object.defineProperty(navigator, 'permissions', {
    configurable: true,
    value: { query: async () => ({ state: readGranted ? 'granted' : 'prompt' }) },
  });
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('writeTextWithHygiene', () => {
  it('copies immediately and clears after the configured delay', async () => {
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 60 });
    await writeTextWithHygiene('secret outline');
    expect(clipboardText).toBe('secret outline');

    await vi.advanceTimersByTimeAsync(59_000);
    expect(clipboardText).toBe('secret outline');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(clipboardText).toBe('');
  });

  it('never schedules a clear when the toggle is off', async () => {
    setLocal({ paranoidClipboardClearEnabled: false });
    await writeTextWithHygiene('keep me');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(clipboardText).toBe('keep me');
  });

  it('never schedules a clear when Paranoid is off', async () => {
    paranoidOn = false;
    setLocal({ paranoidClipboardClearEnabled: true });
    await writeTextWithHygiene('keep me');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(clipboardText).toBe('keep me');
  });

  it('a second copy resets the countdown — the fresh content is not wiped early', async () => {
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 60 });
    await writeTextWithHygiene('first');
    await vi.advanceTimersByTimeAsync(40_000);
    await writeTextWithHygiene('second');
    // The first copy's 60s would fire here — must be superseded
    await vi.advanceTimersByTimeAsync(20_000);
    expect(clipboardText).toBe('second');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(clipboardText).toBe('');
  });

  it('with read permission, leaves foreign content the user copied since alone', async () => {
    readGranted = true;
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 30 });
    await writeTextWithHygiene('ours');
    clipboardText = 'user copied this elsewhere'; // simulate a later copy
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboardText).toBe('user copied this elsewhere');
  });

  it('without read permission, clears unconditionally (can\'t verify)', async () => {
    readGranted = false;
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 30 });
    await writeTextWithHygiene('ours');
    clipboardText = 'something else';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboardText).toBe(''); // blind clear
  });

  it('defers the clear to the next focus when the app is unfocused', async () => {
    focused = false;
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 30 });
    await writeTextWithHygiene('ours');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboardText).toBe('ours'); // not cleared while unfocused

    focused = true;
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
    expect(clipboardText).toBe('');
  });
});

describe('writeClipboardItemWithHygiene', () => {
  it('writes the item and schedules an unconditional (image) clear', async () => {
    setLocal({ paranoidClipboardClearEnabled: true, paranoidClipboardClearSeconds: 30 });
    clipboardText = 'placeholder'; // stand-in for image content we can't read back
    await writeClipboardItemWithHygiene([{ } as ClipboardItem]);
    expect(write).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(clipboardText).toBe(''); // image path always clears (expected=null)
  });
});

describe('clampClipboardClearSeconds', () => {
  it('clamps to [10, 300], defaulting garbage', () => {
    expect(clampClipboardClearSeconds(60)).toBe(60);
    expect(clampClipboardClearSeconds(5)).toBe(10);
    expect(clampClipboardClearSeconds(9999)).toBe(300);
    expect(clampClipboardClearSeconds('nope')).toBe(DEFAULT_CLIPBOARD_CLEAR_SECONDS);
  });
});
