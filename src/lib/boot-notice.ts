// Notices for before (or beside) React: a start held up by IndexedDB must say so
// rather than show a blank page.

/** Show `text` in a plain-DOM bar at the top of the page; returns its remover. */
export function showBootNotice(text: string): () => void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return () => {};
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  bar.textContent = text;
  Object.assign(bar.style, {
    position: 'fixed', top: '0', left: '0', right: '0', zIndex: '400', padding: '10px 16px',
    background: '#d97706', color: '#fff', font: '14px system-ui, sans-serif', textAlign: 'center',
  });
  document.body.appendChild(bar);
  return () => bar.remove();
}

/** `promise`, calling `onSlow` once it has taken longer than `ms` (and undoing it when it settles). */
export async function noticeIfSlow<T>(promise: Promise<T>, ms: number, onSlow: () => () => void): Promise<T> {
  let hide: (() => void) | undefined;
  const timer = setTimeout(() => { hide = onSlow(); }, ms);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
    hide?.();
  }
}
