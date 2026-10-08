import { API_BASE_URL } from '../config';
import { createSseParser } from './sse';
import { API_PORT_NAME, isApiRelayRequest, relayApiRequest } from './api-relay';

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** No bytes at all (not even the server's 15s heartbeat) for this long = stalled. */
export const STREAM_IDLE_TIMEOUT_MS = 60_000;

async function errorEventFromResponse(response: Response): Promise<StreamEvent> {
  let body: { code?: unknown; error?: unknown; retryAfterSec?: unknown } = {};
  try {
    body = await response.json();
  } catch {
    // Non-JSON error page (e.g. a proxy) — fall back to the status code.
  }
  return {
    type: 'error',
    code: typeof body.code === 'string' ? body.code : response.status === 429 ? 'RATE_LIMITED' : 'SERVER_ERROR',
    message: typeof body.error === 'string' ? body.error : `The GitGuide server returned an error (HTTP ${response.status}).`,
    ...(typeof body.retryAfterSec === 'number' ? { retryAfterSec: body.retryAfterSec } : {}),
  };
}

/**
 * Relays the API's SSE stream over `port`. Exactly one terminal event is always sent
 * (unless the port went away first): the server's own `done`/`error`, or a synthesized
 * error when the stream breaks — malformed data, a stall, or EOF before `done`. An
 * incomplete stream is never reported as success.
 *
 * `signal` is aborted when the panel disconnects the port (Stop, navigation, tab
 * closed); passing it to fetch makes the server see the disconnect and stop generating.
 */
export async function streamSse(port: chrome.runtime.Port, apiPath: string, body: unknown, signal: AbortSignal): Promise<void> {
  const send = (event: StreamEvent) => {
    if (!signal.aborted) port.postMessage(event);
  };

  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), STREAM_IDLE_TIMEOUT_MS);
  };

  let streamStarted = false;
  try {
    resetIdle();
    const response = await fetch(`${API_BASE_URL}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, idle.signal]),
      credentials: 'omit',
    });

    if (!response.ok) {
      send(await errorEventFromResponse(response));
      return;
    }
    if (!response.body) {
      send({ type: 'error', code: 'STREAM_INTERRUPTED', message: 'The answer stream could not be opened.' });
      return;
    }

    streamStarted = true;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();

    const handlePayloads = (payloads: string[]): boolean => {
      for (const payload of payloads) {
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          send({ type: 'error', code: 'MALFORMED_STREAM', message: 'The GitGuide server sent a response that could not be read.' });
          return true;
        }
        if (typeof event !== 'object' || event === null || typeof (event as StreamEvent).type !== 'string') {
          send({ type: 'error', code: 'MALFORMED_STREAM', message: 'The GitGuide server sent a response that could not be read.' });
          return true;
        }
        send(event as StreamEvent);
        const type = (event as StreamEvent).type;
        if (type === 'done' || type === 'error') return true;
      }
      return false;
    };

    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      if (handlePayloads(parser.push(decoder.decode(value, { stream: true })))) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
    if (handlePayloads(parser.push(decoder.decode()).concat(parser.end()))) return;

    // EOF without a terminal event: the answer was cut off.
    send({ type: 'error', code: 'STREAM_INTERRUPTED', message: 'The answer was cut off before it finished. You can retry.' });
  } catch {
    if (signal.aborted) return; // the panel went away — nothing to report to
    if (idle.signal.aborted) {
      send({ type: 'error', code: 'UPSTREAM_TIMEOUT', message: 'The answer stalled. Please try again.' });
      return;
    }
    if (streamStarted) {
      // The connection dropped after the answer had started arriving.
      send({ type: 'error', code: 'STREAM_INTERRUPTED', message: 'The answer was cut off before it finished. You can retry.' });
      return;
    }
    send({
      type: 'error',
      code: 'API_UNREACHABLE',
      message: "Couldn't reach the GitGuide server. Check your connection. If the server was idle, it can take up to a minute to start.",
    });
  } finally {
    clearTimeout(idleTimer);
  }
}

/** Accepts chat requests only from this extension's own content scripts on github.com. */
export function isTrustedSender(port: chrome.runtime.Port): boolean {
  const sender = port.sender;
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? sender.tab?.url ?? '';
  return url.startsWith('https://github.com/');
}

function isChatRequest(msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as { question?: unknown; context?: { repoOwner?: unknown; repoName?: unknown } };
  return typeof m.question === 'string' && typeof m.context?.repoOwner === 'string' && typeof m.context?.repoName === 'string';
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== API_PORT_NAME || !isTrustedSender(port)) return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  let started = false;
  port.onMessage.addListener((msg) => {
    if (started || !isApiRelayRequest(msg)) return;
    started = true;
    void relayApiRequest(port, msg, controller.signal);
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream' || !isTrustedSender(port)) return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  let started = false;
  port.onMessage.addListener((msg) => {
    // One question per port; a second message on the same port is ignored.
    if (started || !isChatRequest(msg)) return;
    started = true;
    streamSse(port, '/v1/ask-repo', msg, controller.signal).catch(() => {
      // streamSse reports every failure as an event; this only guards against an
      // unexpected throw surfacing as an unhandled rejection in the worker.
    });
  });
});
