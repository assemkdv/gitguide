import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockPort, flush, MockPort } from '../test/chrome-mock';

function streamResponse(chunks: string[], { hang = false } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!hang) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let connectListeners: Array<(port: chrome.runtime.Port) => void>;
let streamSse: typeof import('./service-worker').streamSse;

beforeEach(async () => {
  connectListeners = [];
  (globalThis as any).chrome = {
    runtime: { id: 'ext-id', onConnect: { addListener: (fn: any) => connectListeners.push(fn) } },
  };
  vi.resetModules();
  ({ streamSse } = await import('./service-worker'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connect(overrides: Partial<{ name: string; sender: unknown }> = {}): MockPort {
  const port = createMockPort(overrides.name ?? 'chat-stream') as MockPort & { sender?: unknown };
  port.sender = 'sender' in overrides ? overrides.sender : { id: 'ext-id', url: 'https://github.com/owner/repo' };
  connectListeners.forEach((fn) => fn(port as unknown as chrome.runtime.Port));
  return port;
}

const request = { question: 'q', context: { repoOwner: 'o', repoName: 'r' }, history: [] };

async function run(response: Response | Promise<Response>): Promise<unknown[]> {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  const port = createMockPort('chat-stream');
  await streamSse(port as unknown as chrome.runtime.Port, '/v1/ask-repo', request, new AbortController().signal);
  return port.posted;
}

describe('service worker chat relay', () => {
  it('relays events in order and stops after done', async () => {
    const posted = await run(
      streamResponse([
        'data: {"type":"status","index":{}}\n\n',
        'data: {"type":"citations","citations":[]}\n\ndata: {"type":"chu',
        'nk","content":"Hi"}\n\n: keep-alive\n\n',
        'data: {"type":"done","finishReason":"stop"}\n\ndata: {"type":"chunk","content":"after done"}\n\n',
      ]),
    );
    expect(posted.map((e: any) => e.type)).toEqual(['status', 'citations', 'chunk', 'done']);
  });

  it('reports EOF before done as an interruption, never as success', async () => {
    const posted = await run(streamResponse(['data: {"type":"chunk","content":"partial"}\n\n']));
    expect(posted.at(-1)).toMatchObject({ type: 'error', code: 'STREAM_INTERRUPTED' });
    expect(posted.some((e: any) => e.type === 'done')).toBe(false);
  });

  it('accepts a final done event that lacks the trailing blank line', async () => {
    const posted = await run(streamResponse(['data: {"type":"chunk","content":"x"}\n\ndata: {"type":"done"}']));
    expect(posted.at(-1)).toEqual({ type: 'done' });
  });

  it('reports malformed event data as an error and stops', async () => {
    const posted = await run(streamResponse(['data: {"type":"chunk","content":"x"}\n\ndata: {not json\n\ndata: {"type":"done"}\n\n']));
    expect(posted.map((e: any) => e.type)).toEqual(['chunk', 'error']);
    expect(posted.at(-1)).toMatchObject({ code: 'MALFORMED_STREAM' });
  });

  it('passes through the structured error from a non-OK response', async () => {
    const posted = await run(
      new Response(JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED', retryAfterSec: 900 }), { status: 429 }),
    );
    expect(posted).toEqual([{ type: 'error', code: 'RATE_LIMITED', message: 'Too many requests', retryAfterSec: 900 }]);
  });

  it('handles a non-JSON error page', async () => {
    const posted = await run(new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(posted[0]).toMatchObject({ type: 'error', code: 'SERVER_ERROR' });
  });

  it('reports a connection dropped mid-answer as an interruption, not as an unreachable server', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"chunk","content":"half"}\n\n'));
        setTimeout(() => controller.error(new TypeError('network error')), 5);
      },
    });
    const posted = await run(new Response(body));
    expect(posted.map((e: any) => e.type)).toEqual(['chunk', 'error']);
    expect(posted.at(-1)).toMatchObject({ code: 'STREAM_INTERRUPTED' });
  });

  it('reports an unreachable API', async () => {
    const posted = await run(Promise.reject(new TypeError('Failed to fetch')));
    expect(posted).toEqual([expect.objectContaining({ type: 'error', code: 'API_UNREACHABLE' })]);
  });

  it('times out a stalled stream', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"type":"chunk","content":"x"}\n\n'));
            init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          },
        });
        return new Response(body);
      }),
    );
    const port = createMockPort('chat-stream');
    const done = streamSse(port as unknown as chrome.runtime.Port, '/v1/ask-repo', request, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(61_000);
    await done;
    expect(port.posted.at(-1)).toMatchObject({ type: 'error', code: 'UPSTREAM_TIMEOUT' });
  });

  it('aborts the request when the panel disconnects and never posts afterwards', async () => {
    let fetchSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        fetchSignal = init.signal as AbortSignal;
        return streamResponse(['data: {"type":"chunk","content":"x"}\n\n'], { hang: true });
      }),
    );
    const port = connect();
    port.emit(request);
    await flush();
    port.remoteDisconnect();
    await flush();
    expect(fetchSignal?.aborted).toBe(true);
    expect(port.posted.map((e: any) => e.type)).toEqual(['chunk']);
  });

  it('ignores other port names, untrusted senders, malformed requests, and repeat messages', async () => {
    const fetchMock = vi.fn(async () => streamResponse(['data: {"type":"done"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    connect({ name: 'other' }).emit(request);
    connect({ sender: { id: 'someone-else', url: 'https://github.com/x' } }).emit(request);
    connect({ sender: { id: 'ext-id', url: 'https://evil.example/' } }).emit(request);
    connect().emit({ question: 42 });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();

    const port = connect();
    port.emit(request);
    port.emit(request);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
