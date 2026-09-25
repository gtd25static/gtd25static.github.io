export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

type NudgeNotificationOptions = NotificationOptions & {
  renotify?: boolean;
};

/**
 * Close every notification this app has showing (nudges quote task titles).
 * Only notifications shown through the service worker can be enumerated; one
 * shown without it, and the OS's own notification history, are out of reach.
 * Best-effort: never throws.
 */
export async function closeAllNotifications(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    for (const notification of (await registration?.getNotifications()) ?? []) notification.close();
  } catch { /* no service worker or notifications in this context */ }
}

const TIMER_NOTIFICATION_TAG = 'gtd25-pomodoro';
const TIMER_NOTIFICATION_MS = 3000;

/**
 * Brief "Pomodoro Complete" notification, closed again after 3s. Shown through
 * the service worker when there is one, like nudges: Android Chrome rejects
 * `new Notification()` outright ("Illegal constructor"), and a SW notification
 * is also one closeAllNotifications() can reach on lock/wipe. Never throws.
 */
export function showTimerNotification(): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const title = 'Pomodoro Complete';
  const options: NotificationOptions = {
    body: 'Your timer has finished!',
    icon: '/favicon.ico',
    silent: true, // we play our own bell
    tag: TIMER_NOTIFICATION_TAG,
  };

  const showWindowNotification = () => {
    try {
      const n = new Notification(title, options);
      setTimeout(() => n.close(), TIMER_NOTIFICATION_MS);
    } catch {
      // Not constructible here (Android Chrome without a SW registration).
    }
  };

  const serviceWorker = navigator.serviceWorker;
  if (serviceWorker && typeof serviceWorker.getRegistration === 'function') {
    void serviceWorker.getRegistration()
      .then(async (registration) => {
        if (!registration || typeof registration.showNotification !== 'function') {
          showWindowNotification();
          return;
        }
        await registration.showNotification(title, options);
        setTimeout(() => {
          void registration.getNotifications({ tag: TIMER_NOTIFICATION_TAG })
            .then((shown) => { for (const n of shown) n.close(); })
            .catch(() => { /* best-effort */ });
        }, TIMER_NOTIFICATION_MS);
      })
      .catch(showWindowNotification);
    return;
  }

  showWindowNotification();
}

function appOpenUrl(): string {
  try {
    return new URL('/', window.location.origin).href;
  } catch {
    return '/';
  }
}

// Reused AudioContext for the nudge chime (browsers cap the number of contexts).
let chimeCtx: AudioContext | null = null;

/**
 * Play a short, discreet two-note chime as a gentle audible cue for nudges.
 * Synthesized via the Web Audio API so it needs no imported sound assets.
 * Silently no-ops if audio is unavailable or blocked by autoplay policy.
 */
export function playNudgeChime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    chimeCtx = chimeCtx ?? new Ctx();
    if (chimeCtx.state === 'suspended') void chimeCtx.resume();
    const ctx = chimeCtx;
    const start = ctx.currentTime;

    // A5 → E6, soft sine notes with a quick attack and gentle decay.
    const notes = [
      { freq: 880, at: 0 },
      { freq: 1318.5, at: 0.12 },
    ];
    for (const { freq, at } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t0 = start + at;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.12, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    }
  } catch {
    // Audio not available — stay silent.
  }
}

/**
 * Show a gentle nudge notification. Nudges should remain visible in the OS
 * notification center, so we do not auto-close them like the pomodoro timer.
 * Clicking it focuses or opens the app.
 */
export function showNudgeNotification(title: string, body: string, opts?: { sound?: boolean }): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options: NudgeNotificationOptions = {
    body,
    icon: '/favicon.ico',
    badge: '/pwa-192.png',
    silent: true,
    tag: 'gtd25-nudge', // collapse repeated nudges into one
    renotify: true,
    requireInteraction: true,
    data: { url: appOpenUrl() },
  };

  const showWindowNotification = () => {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  };

  if (opts?.sound) playNudgeChime();

  const serviceWorker = navigator.serviceWorker;
  if (serviceWorker && typeof serviceWorker.getRegistration === 'function') {
    void serviceWorker.getRegistration()
      .then((registration) => {
        if (registration && typeof registration.showNotification === 'function') {
          return registration.showNotification(title, options);
        }
        showWindowNotification();
      })
      .catch(showWindowNotification);
    return;
  }

  showWindowNotification();
}
