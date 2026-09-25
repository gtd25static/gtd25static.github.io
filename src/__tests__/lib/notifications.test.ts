// @vitest-environment jsdom
import { showNudgeNotification, showTimerNotification } from '../../lib/notifications';

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

// Android Chrome always rejects `new Notification()` ("Illegal constructor. Use
// ServiceWorkerRegistration.showNotification()"): the pomodoro notification
// threw, and the completion handler stopped before resetting its state.
describe('showTimerNotification', () => {
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

  function installRegistration() {
    const shown = { close: vi.fn() };
    const registration = {
      showNotification: vi.fn().mockResolvedValue(undefined),
      getNotifications: vi.fn().mockResolvedValue([shown]),
    };
    Object.defineProperty(window.navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue(registration) },
    });
    return { registration, shown };
  }

  it('shows through the service worker registration, tagged, and closes it after 3s', async () => {
    vi.useFakeTimers();
    const { registration, shown } = installRegistration();

    showTimerNotification();
    await vi.advanceTimersByTimeAsync(0);

    expect(registration.showNotification).toHaveBeenCalledWith('Pomodoro Complete', expect.objectContaining({
      body: 'Your timer has finished!',
      tag: 'gtd25-pomodoro',
      silent: true,
    }));
    expect(instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3000);
    expect(registration.getNotifications).toHaveBeenCalledWith({ tag: 'gtd25-pomodoro' });
    expect(shown.close).toHaveBeenCalled();
  });

  it('falls back to a window notification without a service worker', () => {
    showTimerNotification();
    expect(instances).toHaveLength(1);
    expect(instances[0].title).toBe('Pomodoro Complete');
  });

  it('never throws when the Notification constructor is illegal (Android)', async () => {
    class IllegalNotification {
      static permission: NotificationPermission = 'granted';
      constructor() {
        throw new TypeError("Failed to construct 'Notification': Illegal constructor.");
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: IllegalNotification });
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: IllegalNotification });
    const getRegistration = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: { getRegistration } });

    expect(() => showTimerNotification()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(getRegistration).toHaveBeenCalled();
    // (the fallback throwing inside the promise chain would surface as an
    // unhandled rejection and fail the run)
  });
});
