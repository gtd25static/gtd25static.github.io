// @vitest-environment jsdom
import { showNudgeNotification } from '../../lib/notifications';

type MockNotificationInstance = {
  title: string;
  options?: NotificationOptions;
  onclick: ((event: Event) => void) | null;
  close: ReturnType<typeof vi.fn>;
};

const instances: MockNotificationInstance[] = [];

class MockNotification {
  static permission: NotificationPermission = 'granted';
  title: string;
  options?: NotificationOptions;
  onclick: ((event: Event) => void) | null = null;
  close = vi.fn();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    instances.push(this);
  }
}

function installNotificationMock() {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: MockNotification,
  });
}

function clearServiceWorkerMock() {
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: undefined,
  });
}

describe('showNudgeNotification', () => {
  beforeEach(() => {
    instances.length = 0;
    MockNotification.permission = 'granted';
    installNotificationMock();
    clearServiceWorkerMock();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses persistent notification options and does not auto-close window notifications', () => {
    vi.useFakeTimers();

    showNudgeNotification('A gentle nudge', 'Pick up the task.');

    expect(instances).toHaveLength(1);
    expect(instances[0].options).toEqual(expect.objectContaining({
      body: 'Pick up the task.',
      tag: 'gtd25-nudge',
      renotify: true,
      requireInteraction: true,
      silent: true,
    }));

    vi.advanceTimersByTime(10_000);
    expect(instances[0].close).not.toHaveBeenCalled();
  });

  it('prefers service worker notifications when a registration is available', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue({ showNotification }),
      },
    });

    showNudgeNotification('A gentle nudge', 'Pick up the task.');
    await Promise.resolve();
    await Promise.resolve();

    expect(showNotification).toHaveBeenCalledWith('A gentle nudge', expect.objectContaining({
      body: 'Pick up the task.',
      tag: 'gtd25-nudge',
      requireInteraction: true,
    }));
    expect(instances).toHaveLength(0);
  });

  it('falls back to window notifications when no service worker registration exists', async () => {
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: {
        getRegistration: vi.fn().mockResolvedValue(undefined),
      },
    });

    showNudgeNotification('A gentle nudge', 'Pick up the task.');
    await Promise.resolve();
    await Promise.resolve();

    expect(instances).toHaveLength(1);
    expect(instances[0].title).toBe('A gentle nudge');
  });
});
