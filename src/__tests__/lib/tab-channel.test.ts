import { signalOtherTabs, onTabSignal, __resetTabChannelForTests, type TabSignal } from '../../lib/tab-channel';

const CHANNEL_NAME = 'gtd25-tabs';

/** Stand-in for a second tab: its own channel object on the same name. */
function otherTab() {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post: (signal: unknown) => channel.postMessage(signal),
    received: [] as unknown[],
    listen() {
      channel.addEventListener('message', (e) => this.received.push((e as MessageEvent).data));
      return this;
    },
    close: () => channel.close(),
  };
}

/** BroadcastChannel delivery is asynchronous. */
const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  __resetTabChannelForTests();
});

describe('tab-channel', () => {
  it('delivers a signal to another tab', async () => {
    const other = otherTab().listen();
    signalOtherTabs({ type: 'lock' });
    await settle();
    expect(other.received).toEqual([{ type: 'lock' }]);
    other.close();
  });

  it('never delivers a signal back to the sender', async () => {
    // This is what stops lock-propagation from ping-ponging between two tabs.
    const seen: TabSignal[] = [];
    const off = onTabSignal((s) => seen.push(s));
    signalOtherTabs({ type: 'lock' });
    await settle();
    expect(seen).toEqual([]);
    off();
  });

  it('receives what another tab sends, and ignores anything else on the channel', async () => {
    const seen: TabSignal[] = [];
    const off = onTabSignal((s) => seen.push(s));
    const other = otherTab();

    other.post({ type: 'lock' });
    other.post({ type: 'wipe' });
    other.post({ type: 'unlock' });     // there is no such signal, by design
    other.post({ type: 'lock', dek: 'x' }); // extra fields are not trusted, only the type
    other.post('lock');
    other.post(null);
    await settle();

    expect(seen).toEqual([{ type: 'lock' }, { type: 'wipe' }, { type: 'lock', dek: 'x' }]);
    off();
    other.close();
  });

  it('stops delivering after unsubscribe', async () => {
    const seen: TabSignal[] = [];
    const off = onTabSignal((s) => seen.push(s));
    off();
    const other = otherTab();
    other.post({ type: 'lock' });
    await settle();
    expect(seen).toEqual([]);
    other.close();
  });

  it('is a no-op where BroadcastChannel does not exist', () => {
    const original = globalThis.BroadcastChannel;
    // @ts-expect-error — simulating an environment without the API
    delete globalThis.BroadcastChannel;
    __resetTabChannelForTests();
    try {
      expect(() => signalOtherTabs({ type: 'lock' })).not.toThrow();
      const off = onTabSignal(() => { throw new Error('must not be called'); });
      expect(() => off()).not.toThrow();
    } finally {
      globalThis.BroadcastChannel = original;
      __resetTabChannelForTests();
    }
  });
});
