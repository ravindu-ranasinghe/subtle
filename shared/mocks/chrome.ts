/**
 * Enough of chrome.runtime / chrome.tabs to unit-test message plumbing in
 * Node. Synchronous delivery: a sendMessage has reached its listeners by the
 * time it returns.
 */

import type { Message } from '../messages.js';

type Sender = { tab?: { id: number }; id?: string };
type Listener = (m: Message, sender: Sender, respond: (r?: unknown) => void) => boolean | void;

class Event {
  readonly listeners: Listener[] = [];
  addListener(l: Listener): void {
    this.listeners.push(l);
  }
  removeListener(l: Listener): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  hasListener(l: Listener): boolean {
    return this.listeners.includes(l);
  }
}

export interface FakeChrome {
  runtime: {
    id: string;
    onMessage: Event;
    sendMessage(m: Message): Promise<unknown>;
    getURL(path: string): string;
  };
  tabs: {
    /** Listeners registered per tab id, as if each tab had a content script. */
    onMessage: Map<number, Event>;
    sendMessage(tabId: number, m: Message): Promise<unknown>;
  };
  /** Everything sent, in order, for assertions. */
  readonly sent: { to: 'runtime' | number; message: Message }[];
  /** Swap this in as globalThis.chrome; returns a function that restores it. */
  install(): () => void;
  reset(): void;
}

export function fakeChrome(): FakeChrome {
  const sent: { to: 'runtime' | number; message: Message }[] = [];
  const runtimeEvent = new Event();
  const tabEvents = new Map<number, Event>();

  const deliver = (event: Event, m: Message, sender: Sender): Promise<unknown> => {
    let response: unknown;
    for (const l of [...event.listeners]) l(m, sender, (r) => (response = r));
    return Promise.resolve(response);
  };

  const fake: FakeChrome = {
    runtime: {
      id: 'mock-extension-id',
      onMessage: runtimeEvent,
      sendMessage(m) {
        sent.push({ to: 'runtime', message: m });
        return deliver(runtimeEvent, m, { id: 'mock-extension-id' });
      },
      getURL: (path) => `chrome-extension://mock-extension-id/${path.replace(/^\//, '')}`,
    },
    tabs: {
      onMessage: tabEvents,
      sendMessage(tabId, m) {
        sent.push({ to: tabId, message: m });
        const event = tabEvents.get(tabId);
        if (!event) return Promise.reject(new Error(`no listener for tab ${tabId}`));
        return deliver(event, m, { tab: { id: tabId } });
      },
    },
    sent,
    install() {
      const globals = globalThis as { chrome?: unknown };
      const previous = globals.chrome;
      globals.chrome = fake;
      return () => {
        globals.chrome = previous;
      };
    },
    reset() {
      sent.length = 0;
      runtimeEvent.listeners.length = 0;
      tabEvents.clear();
    },
  };
  return fake;
}

/** Register a listener for a fake tab, as a content script would. */
export function listenOnTab(fake: FakeChrome, tabId: number, listener: Listener): void {
  let event = fake.tabs.onMessage.get(tabId);
  if (!event) {
    event = new Event();
    fake.tabs.onMessage.set(tabId, event);
  }
  event.addListener(listener);
}
