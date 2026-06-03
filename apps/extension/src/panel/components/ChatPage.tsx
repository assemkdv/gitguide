import { useEffect, useRef, KeyboardEvent } from 'react';
import { useStore, repoKeyOf } from '../store';
import { loadRepoChatMessages, saveRepoChatMessages, clearRepoChatMessages } from '../storage';
import { BackButton, SC as C } from './shared';

export function ChatPage() {
  const {
    pageContext,
    goToQuickActions,
    chatMessages,
    chatInput,
    chatStreaming,
    chatContextNote,
    setChatInput,
    addChatMessage,
    appendToLastChatMessage,
    setChatMessages,
    setChatStreaming,
    setChatContextNote,
    resetChat,
  } = useStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadedForRef = useRef('');

  const repoKey = pageContext ? repoKeyOf(pageContext.repoOwner, pageContext.repoName) : null;

  useEffect(() => {
    if (!repoKey || loadedForRef.current === repoKey) return;
    loadedForRef.current = repoKey;
    loadRepoChatMessages(repoKey).then((stored) => {
      if (loadedForRef.current === repoKey) setChatMessages(stored);
    });
    // setChatMessages is a zustand action — stable across renders, safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('keydown', stop);
    el.addEventListener('keyup', stop);
    return () => {
      el.removeEventListener('keydown', stop);
      el.removeEventListener('keyup', stop);
    };
  }, []);

  const handleSend = () => {
    const text = chatInput.trim();
    if (!text || chatStreaming || !pageContext || !repoKey) return;

    setChatInput('');
    addChatMessage({ role: 'user', content: text });
    saveRepoChatMessages(repoKey, useStore.getState().chatMessages);

    addChatMessage({ role: 'assistant', content: '' });
    setChatStreaming(true);

    const port = chrome.runtime.connect({ name: 'chat-stream' });
    port.postMessage({
      message: text,
      context: {
        repoOwner: pageContext.repoOwner,
        repoName: pageContext.repoName,
        issueNumber: pageContext.page === 'issue' ? pageContext.issueNumber : undefined,
        issueTitle: pageContext.page === 'issue' ? pageContext.issueTitle : undefined,
        filePath: pageContext.page === 'file' ? pageContext.filePath : undefined,
        resultContext: chatContextNote ?? undefined,
      },
    });

    port.onMessage.addListener((msg: { type: string; content?: string; message?: string }) => {
      if (msg.type === 'chunk' && msg.content) {
        appendToLastChatMessage(msg.content);
      } else if (msg.type === 'done' || msg.type === 'error') {
        if (msg.type === 'error') {
          appendToLastChatMessage('\n\n*Error: ' + (msg.message ?? 'Unknown error') + '*');
        }
        setChatStreaming(false);
        port.disconnect();
        saveRepoChatMessages(repoKey, useStore.getState().chatMessages);
      }
    });

    port.onDisconnect.addListener(() => setChatStreaming(false));
  };

  const handleClearHistory = async () => {
    if (!repoKey) return;
    await clearRepoChatMessages(repoKey);
    resetChat();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!pageContext) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ borderBottom: `1px solid ${C.borderMuted}`, display: 'flex', alignItems: 'center', flexShrink: 0, background: C.bgSec }}>
        <BackButton onClick={goToQuickActions} />
        <span style={{ color: C.muted, fontSize: 11, flex: 1 }}>
          {pageContext.repoOwner}/{pageContext.repoName}
        </span>
        {chatMessages.length > 0 && (
          <button
            onClick={handleClearHistory}
            disabled={chatStreaming}
            title="Clear chat history for this repository"
            style={{
              background: 'none',
              border: 'none',
              color: C.muted,
              cursor: chatStreaming ? 'default' : 'pointer',
              padding: '3px 16px 3px 6px',
              borderRadius: 5,
              fontSize: 11,
              fontFamily: 'inherit',
              opacity: chatStreaming ? 0.4 : 1,
            }}
          >
            Clear
          </button>
        )}
      </div>

      {chatContextNote && (
        <div
          style={{
            padding: '8px 16px',
            borderBottom: `1px solid ${C.borderMuted}`,
            fontSize: 11,
            color: C.mutedDim,
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            alignItems: 'center',
          }}
        >
          <span>Continuing with your last generated result as context.</span>
          <button
            onClick={() => setChatContextNote(null)}
            style={{ background: 'none', border: 'none', color: C.mutedDim, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', flexShrink: 0 }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {chatMessages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginTop: 40, padding: '0 20px', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: C.textSub }}>Ask GitGuide anything about this repository.</p>
            <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              Try asking about the architecture, where to start, or how a specific file works.
            </p>
          </div>
        )}

        {chatMessages.map((msg, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: msg.role === 'user' ? C.accent : '#6e7681',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {msg.role === 'user' ? 'You' : 'GitGuide'}
            </span>
            <div
              style={{
                background: msg.role === 'user' ? C.accentDim : C.bgSec,
                border: `1px solid ${msg.role === 'user' ? C.accentBorder : C.borderMuted}`,
                borderRadius: 10,
                padding: '10px 13px',
                fontSize: 13,
                color: C.textSub,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.content}
              {msg.role === 'assistant' && chatStreaming && i === chatMessages.length - 1 && msg.content === '' && (
                <span style={{ color: C.muted }}>Thinking…</span>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.borderMuted}`, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0, background: C.bg }}>
        <textarea
          ref={textareaRef}
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => e.stopPropagation()}
          placeholder="Ask about this repository…"
          rows={1}
          disabled={chatStreaming}
          style={{
            flex: 1,
            background: C.bgTer,
            border: `1px solid ${C.borderMuted}`,
            borderRadius: 8,
            padding: '8px 11px',
            color: C.text,
            fontSize: 13,
            fontFamily: 'inherit',
            resize: 'none',
            outline: 'none',
            lineHeight: 1.5,
            minHeight: 36,
            maxHeight: 120,
            overflowY: 'auto',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = C.accent;
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = C.borderMuted;
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          }}
        />
        <button
          onClick={handleSend}
          disabled={!chatInput.trim() || chatStreaming}
          style={{
            width: 34,
            height: 34,
            background: chatInput.trim() && !chatStreaming ? C.accent : C.bgTer,
            color: chatInput.trim() && !chatStreaming ? C.bg : C.muted,
            border: `1px solid ${chatInput.trim() && !chatStreaming ? C.accent : C.borderMuted}`,
            borderRadius: '50%',
            fontSize: 14,
            cursor: chatInput.trim() && !chatStreaming ? 'pointer' : 'default',
            fontFamily: 'inherit',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          {chatStreaming ? (
            <span style={{ fontSize: 11 }}>…</span>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
