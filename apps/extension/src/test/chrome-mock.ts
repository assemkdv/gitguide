// Minimal in-memory stand-in for the chrome.* APIs the extension uses, for unit tests.
import { vi } from 'vitest';
import { API_PORT_NAME, isApiRelayRequest, relayApiRequest } from '../background/api-relay';

export interface MockPort {
  name: string;
  posted: unknown[];
  disconnected: boolean;
  postMessage: (msg: unknown) => void;
  disconnect: () => void;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  /** Simulates the other side sending a message to this port. */
  emit: (msg: unknown) => void;
  /** Simulates the other side disconnecting (fires onDisconnect). */
  remoteDisconnect: () => void;
}

export function createMockPort(name: string): MockPort {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: MockPort = {
    name,
    posted: [],
    disconnected: false,
    postMessage: (msg) => {
      if (port.disconnected) throw new Error('Attempting to use a disconnected port object');
      port.posted.push(msg);
    },
    // Like Chrome: a local disconnect() does not fire this side's onDisconnect.
    disconnect: () => {
      port.disconnected = true;
    },
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    emit: (msg) => {
      if (!port.disconnected) messageListeners.forEach((fn) => fn(msg));
    },
    remoteDisconnect: () => {
      if (port.disconnected) return;
      port.disconnected = true;
      disconnectListeners.forEach((fn) => fn());
    },
  };
  return port;
}

/** A connected pair, like chrome.runtime.connect: messages posted on one side arrive on
 * the other, and disconnecting one side fires onDisconnect on the other. */
export function createPortPair(name: string): [MockPort, MockPort] {
  const a = createMockPort(name);
  const b = createMockPort(name);
  const link = (from: MockPort, to: MockPort) => {
    const localDisconnect = from.disconnect;
    from.postMessage = (msg) => {
      if (from.disconnected) throw new Error('Attempting to use a disconnected port object');
      from.posted.push(msg);
      queueMicrotask(() => to.emit(structuredClone(msg)));
    };
    from.disconnect = () => {
      localDisconnect();
      queueMicrotask(() => to.remoteDisconnect());
    };
  };
  link(a, b);
  link(b, a);
  return [a, b];
}

export interface ChromeMock {
  store: Record<string, unknown>;
  ports: MockPort[];
  /** When set, chrome.storage.local.set rejects with this error. */
  failSetWith: Error | null;
  failGetWith: Error | null;
}

export function installChromeMock(): ChromeMock {
  const mock: ChromeMock = { store: {}, ports: [], failSetWith: null, failGetWith: null };
  const pick = (keys: string | string[] | null) => {
    if (keys == null) return structuredClone(mock.store);
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of list) if (key in mock.store) out[key] = structuredClone(mock.store[key]);
    return out;
  };
  (globalThis as any).chrome = {
    runtime: {
      id: 'test-extension-id',
      connect: vi.fn(({ name }: { name: string }) => {
        if (name === API_PORT_NAME) {
          // Runs the real service-worker relay on the other end of the port.
          const [client, worker] = createPortPair(name);
          const controller = new AbortController();
          worker.onDisconnect.addListener(() => controller.abort());
          worker.onMessage.addListener((msg) => {
            if (isApiRelayRequest(msg)) void relayApiRequest(worker as unknown as chrome.runtime.Port, msg, controller.signal);
          });
          return client;
        }
        const port = createMockPort(name);
        mock.ports.push(port);
        return port;
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[] | null) => {
          if (mock.failGetWith) throw mock.failGetWith;
          return pick(keys);
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          if (mock.failSetWith) throw mock.failSetWith;
          Object.assign(mock.store, structuredClone(items));
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete mock.store[key];
        }),
      },
    },
  };
  return mock;
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}
