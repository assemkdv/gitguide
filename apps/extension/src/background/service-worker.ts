import { API_BASE_URL } from '../config';

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Reads an SSE response body and relays each parsed `data: ` line back over `port`,
 * stopping after a 'done' or 'error' event — content scripts can't use EventSource
 * against a POST body, so this hand-rolled reader is what makes streaming possible at
 * all.
 *
 * `signal` is aborted the moment the client-side port disconnects (panel closed, user
 * navigated to a different repo, tab closed) — passed straight to `fetch` so the
 * backend's own `res.on('close', ...)` fires and stops paying for tokens no one is
 * listening for anymore, instead of streaming to completion for an abandoned request.
 */
async function streamSse(port: chrome.runtime.Port, apiPath: string, body: unknown, signal: AbortSignal): Promise<void> {
  // Once the port has disconnected, calling postMessage on it throws — every send in
  // this function (including the catch block below) goes through here so that can
  // never happen, rather than checking signal.aborted at every call site individually.
  const send = (event: StreamEvent) => {
    if (!signal.aborted) port.postMessage(event);
  };

  try {
    const response = await fetch(`${API_BASE_URL}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok || !response.body) {
      send({ type: 'error', message: `HTTP ${response.status}` } satisfies StreamEvent);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      if (signal.aborted) return; // port disconnected — stop reading and exit quietly
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const jsonStr = trimmed.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr) as StreamEvent;
          send(event);
          if (event.type === 'done' || event.type === 'error') return;
        } catch {
          // skip malformed SSE line
        }
      }
    }

    send({ type: 'done' } satisfies StreamEvent);
  } catch (err) {
    // An aborted fetch/read rejects with an AbortError here — that's an expected
    // consequence of the port disconnecting, not a real failure, so exit quietly
    // rather than trying to report it (send() would no-op anyway, but this skips
    // building the message at all).
    if (signal.aborted) return;
    send({
      type: 'error',
      message: err instanceof Error ? err.message : 'Connection failed. Is the API running?',
    } satisfies StreamEvent);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream') return;

  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());

  port.onMessage.addListener((msg) => {
    // streamSse already turns every expected failure (HTTP error, network error,
    // malformed SSE line) into a posted 'error' event and never rethrows — this outer
    // catch only guards against something truly unexpected, since onMessage's listener
    // return value is otherwise ignored and an unswallowed rejection here would surface
    // as an unhandled promise rejection in the service worker.
    streamSse(port, '/v1/ask-repo', msg, controller.signal).catch((err) => {
      console.error('chat-stream: unexpected failure', err);
    });
  });
});
