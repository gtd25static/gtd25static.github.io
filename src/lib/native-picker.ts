/**
 * Open a native control's picker (date/time/…) in response to a user gesture —
 * e.g. from an input's onClick, so clicking anywhere in the field (not just the
 * calendar icon) pops the picker.
 *
 * Safe to call unconditionally: a no-op where `showPicker` is unavailable (older
 * browsers, jsdom in tests), and it swallows the error `showPicker` throws when
 * called without transient activation or while a picker is already open.
 */
export function openNativePicker(el: HTMLInputElement): void {
  if (typeof el.showPicker !== 'function') return;
  try {
    el.showPicker();
  } catch {
    /* no transient activation, or a picker is already showing */
  }
}
