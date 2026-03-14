export function updateMediaSession({ title, playing }: { title: string; playing: boolean }): void {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: 'GTD25',
  });
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
}

export function clearMediaSession(): void {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = null;
  navigator.mediaSession.playbackState = 'none';
}

export function registerMediaSessionHandlers({
  onPlay,
  onPause,
  onStop,
}: {
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
}): void {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.setActionHandler('play', onPlay);
  navigator.mediaSession.setActionHandler('pause', onPause);
  navigator.mediaSession.setActionHandler('stop', onStop);
}
