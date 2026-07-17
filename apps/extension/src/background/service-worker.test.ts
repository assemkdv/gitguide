import { describe, it, expect, vi, beforeEach } from 'vitest';

function makePort(name: string) {
  const messages: any[] = [];
  const listeners: Array<(msg: any) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let disconnected = false;
  return {
    name,
    postMessage: (msg: any) => {
      // Mirrors real chrome.runtime.Port behavior: posting to an already-disconnected
      // port throws, rather than silently no-op'ing — this is what makes it possible to
      // assert the production code never calls postMessage after disconnect.
      if (disconnected) throw new Error('Attempting to use a disconnected port object');
      messages.push(msg);
    },
    onMessage: { addListener: (fn: any) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    disconnect: () => {},
    send: (msg: any) => listeners.forEach((fn) => fn(msg)),
    // Simulates the runtime firing onDisconnect (the panel closed, the user switched
    // repos, the tab closed) — not something a test can trigger via `disconnect()`
    // alone, since that's the client-initiated side of the same event.
    triggerDisconnect: () => {
      disconnected = true;
      disconnectListeners.forEach((fn) => fn());
    },
    messages,
  };
}

function installChromeRuntimeMock() {
  const connectListeners: Array<(port: any) => void> = [];
  (globalThis as any).chrome = {
    runtime: {
      onConnect: { addListener: (fn: any) => connectListeners.push(fn) },
    },
  };
  return {
    fireConnect: (port: any) => connectListeners.forEach((fn) => fn(port)),
    listenerCount: () => connectListeners.length,
  };
}

function makeFakeBody(sseChunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (i < sseChunks.length) {
          const value = encoder.encode(sseChunks[i]);
          i++;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      },
    }),
  };
}

// Lets the handler's chain of awaits over the fake reader fully settle before we assert
// on the port's received messages.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('service-worker SSE relay', () => {
  let runtimeMock: ReturnType<typeof installChromeRuntimeMock>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    runtimeMock = installChromeRuntimeMock();
  });

  it('registers a single onConnect listener for chat-stream', async () => {
    await import('./service-worker');
    expect(runtimeMock.listenerCount()).toBe(1);
  });

  it('relays chat-stream events — citations and status before any answer chunk — in order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toBe('http://localhost:3000/v1/ask-repo');
        return {
          ok: true,
          body: makeFakeBody([
            'data: {"type":"citations","citations":[{"path":"src/auth.ts","startLine":1,"endLine":10,"url":"https://github.com/o/r/blob/main/src/auth.ts#L1-L10"}]}\n\n',
            'data: {"type":"status","indexing":"partial"}\n\n',
            'data: {"type":"chunk","content":"It is in "}\n\n',
            'data: {"type":"done"}\n\n',
          ]),
        };
      }),
    );

    await import('./service-worker');
    const port = makePort('chat-stream');
    runtimeMock.fireConnect(port);
    port.send({ question: 'where is auth', context: { repoOwner: 'o', repoName: 'r' } });

    await flush();

    expect(port.messages.map((m: any) => m.type)).toEqual(['citations', 'status', 'chunk', 'done']);
    expect(port.messages[0].citations[0].path).toBe('src/auth.ts');
  });

  it('ignores a connection whose port name does not match', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await import('./service-worker');
    const port = makePort('something-else');
    runtimeMock.fireConnect(port);
    port.send({});

    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a single error event on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, body: null })));

    await import('./service-worker');
    const port = makePort('chat-stream');
    runtimeMock.fireConnect(port);
    port.send({ question: 'q', context: { repoOwner: 'o', repoName: 'r' } });

    await flush();
    expect(port.messages).toEqual([{ type: 'error', message: 'HTTP 500' }]);
  });

  it('aborts the underlying fetch when the port disconnects, and never posts to it again', async () => {
    const seenSignals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        seenSignals.push(signal);
        // Never resolves on its own — mirrors an in-flight request with no response
        // yet, so the only way this promise settles is via the abort below.
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }),
    );

    await import('./service-worker');
    const port = makePort('chat-stream');
    runtimeMock.fireConnect(port);
    port.send({ question: 'q', context: { repoOwner: 'o', repoName: 'r' } });
    await flush();

    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0].aborted).toBe(false);

    port.triggerDisconnect();
    await flush();

    expect(seenSignals[0].aborted).toBe(true);
    expect(port.messages).toEqual([]); // no 'error' (or any other) event posted to a dead port
  });

  it('does not produce an unhandled promise rejection when the port disconnects mid-stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }),
    );

    const onUnhandledRejection = vi.fn();
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await import('./service-worker');
      const port = makePort('chat-stream');
      runtimeMock.fireConnect(port);
      port.send({ question: 'q', context: { repoOwner: 'o', repoName: 'r' } });
      await flush();

      port.triggerDisconnect();
      await flush();
      await flush(); // extra settle time for any stray rejection microtask

      expect(onUnhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});
