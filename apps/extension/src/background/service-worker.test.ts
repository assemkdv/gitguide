import { describe, it, expect, vi, beforeEach } from 'vitest';

function makePort(name: string) {
  const messages: any[] = [];
  const listeners: Array<(msg: any) => void> = [];
  return {
    name,
    postMessage: (msg: any) => {
      messages.push(msg);
    },
    onMessage: { addListener: (fn: any) => listeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    disconnect: () => {},
    send: (msg: any) => listeners.forEach((fn) => fn(msg)),
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
});
