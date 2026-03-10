/// <reference types="vitest/globals" />
import 'fake-indexeddb/auto';

// Polyfill localStorage for node test environment
if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = String(value); },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

// Polyfill document/window event targets for node test environment
if (typeof globalThis.document === 'undefined') {
  const docTarget = new EventTarget();
  globalThis.document = Object.assign(docTarget, {
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    dispatchEvent: docTarget.dispatchEvent.bind(docTarget),
    visibilityState: 'visible' as DocumentVisibilityState,
  }) as unknown as Document;
}

if (typeof globalThis.window === 'undefined') {
  const winTarget = new EventTarget();
  globalThis.window = Object.assign(winTarget, {
    addEventListener: winTarget.addEventListener.bind(winTarget),
    removeEventListener: winTarget.removeEventListener.bind(winTarget),
    dispatchEvent: winTarget.dispatchEvent.bind(winTarget),
  }) as unknown as Window & typeof globalThis;
}
