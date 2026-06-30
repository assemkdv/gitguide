import { API_BASE_URL } from '../config';

interface ChatMessage {
  message: string;
  context: {
    repoOwner: string;
    repoName: string;
    issueNumber?: number;
    issueTitle?: string;
    filePath?: string;
    resultContext?: string;
  };
  history?: { role: 'user' | 'assistant'; content: string }[];
}

interface StreamEvent {
  type: 'chunk' | 'done' | 'error';
  content?: string;
  message?: string;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'chat-stream') return;

  port.onMessage.addListener(async (msg: ChatMessage) => {
    try {
      const response = await fetch(`${API_BASE_URL}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
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
  });
});
