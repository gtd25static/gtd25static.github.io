export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function showTimerNotification(): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification('Pomodoro Complete', {
    body: 'Your timer has finished!',
    icon: '/favicon.ico',
    silent: true, // we play our own bell
  });
  setTimeout(() => n.close(), 3000);
}
