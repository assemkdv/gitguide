import { API_BASE_URL } from '../config';

// JSON API calls from the panel are relayed through the service worker, over a port
// named 'api-request' (one request per port). Running the fetch in the extension's own
// origin, instead of the github.com page's, means:
//   - the request is subject to the extension's host permission, not to github.com's
//     CORS/Local Network Access rules (which block http://localhost during development);
//   - the API sees one consistent Origin (chrome-extension://<id>) for every request;
//   - the panel can cancel by disconnecting the port, which aborts the fetch.

export const API_PORT_NAME = 'api-request';
export const RELAY_TIMEOUT_MS = 90_000;

/** Paths the relay will call. Anything else is refused. */
export const RELAYED_PATHS = new Set(['/v1/explain-repo', '/v1/explain-file', '/v1/explain-file/quick', '/v1/analyze', '/v1/good-first-issues']);

export interface ApiRelayRequest {
  path: string;
  body: unknown;
}

export type ApiRelayResponse =
  | { kind: 'response'; status: number; retryAfter: string | null; body: string }
  | { kind: 'network-error' }
  | { kind: 'timeout' }
  | { kind: 'refused' };

export function isApiRelayRequest(msg: unknown): msg is ApiRelayRequest {
  return typeof msg === 'object' && msg !== null && typeof (msg as ApiRelayRequest).path === 'string' && 'body' in msg;
}

/** Performs one relayed request and answers on the port (unless it was disconnected,
 * which aborts the fetch via `signal`). Never throws. */
export async function relayApiRequest(port: chrome.runtime.Port, request: ApiRelayRequest, signal: AbortSignal): Promise<void> {
  const reply = (message: ApiRelayResponse) => {
    if (!signal.aborted) port.postMessage(message);
  };
  if (!RELAYED_PATHS.has(request.path)) {
    reply({ kind: 'refused' });
    return;
  }
  const timeout = AbortSignal.timeout(RELAY_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE_URL}${request.path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.any([signal, timeout]),
      credentials: 'omit',
    });
    const body = await res.text();
    reply({ kind: 'response', status: res.status, retryAfter: res.headers.get('retry-after'), body });
  } catch {
    if (signal.aborted) return;
    reply(timeout.aborted ? { kind: 'timeout' } : { kind: 'network-error' });
  }
}
