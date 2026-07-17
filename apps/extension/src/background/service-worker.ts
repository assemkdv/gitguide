import { API_BASE_URL } from '../config';

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Reads an SSE response body and relays each parsed `data: ` line back over `port`,
 * stopping after a 'done' or 'error' event. Shared by every streaming endpoint (chat,
 * ask-repo) so the manual SSE-parsing loop — content scripts can't use EventSource
 * against a POST body, so this hand-rolled reader is what makes streaming possible at
 * all — exists in exactly one place instead of being copy-pasted per feature.
 */
async function streamSse(port: chrome.runtime.Port, apiPath: string, body: unknown): Promise<void> {
  try {
    const response = await fetch(`${API_BASE_URL}${apiPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      port.postMessage({ type: 'error', message: `HTTP ${response.status}` } satisfies StreamEvent);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
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
          port.postMessage(event);
          if (event.type === 'done' || event.type === 'error') return;
        } catch {
          // skip malformed SSE line
        }
      }
    }

    port.postMessage({ type: 'done' } satisfies StreamEvent);
  } catch (err) {
    port.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : 'Connection failed. Is the API running?',
    } satisfies StreamEvent);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream') return;
  port.onMessage.addListener((msg) => streamSse(port, '/v1/chat', msg));
});

// Registered as a second, independent listener (not by editing the branch above) so
// this is purely additive — Chrome invokes every registered onConnect listener per
// connection, so the existing chat-stream path is untouched by this addition.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ask-repo-stream') return;
  port.onMessage.addListener((msg) => streamSse(port, '/v1/ask-repo', msg));
});
