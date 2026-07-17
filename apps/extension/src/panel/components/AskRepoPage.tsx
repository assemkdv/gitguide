import { useEffect, useRef, KeyboardEvent } from 'react';
import { useStore, repoKeyOf, Citation } from '../store';
import { loadRepoAskMessages, saveRepoAskMessages, clearRepoAskMessages } from '../storage';
import { BackButton, SC as C } from './shared';

interface AskRepoStreamEvent {
  type: string;
  content?: string;
  message?: string;
  citations?: Citation[];
  indexing?: 'partial' | 'complete';
}

export function AskRepoPage() {
  const {
    pageContext,
    goToQuickActions,
    askRepoMessages,
    askRepoInput,
    askRepoStreaming,
    setAskRepoInput,
    addAskRepoMessage,
    appendToLastAskRepoMessage,
    setLastAskRepoMessageCitations,
    setLastAskRepoMessageIndexingStatus,
    setAskRepoMessages,
    setAskRepoStreaming,
    resetAskRepo,
  } = useStore();

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const loadedForRef = useRef('');
  const portRef = useRef<ReturnType<typeof chrome.runtime.connect> | null>(null);

  const repoKey = pageContext ? repoKeyOf(pageContext.repoOwner, pageContext.repoName) : null;

  useEffect(() => {
    if (!repoKey || loadedForRef.current === repoKey) return;
    loadedForRef.current = repoKey;
    loadRepoAskMessages(repoKey).then((stored) => {
      if (loadedForRef.current === repoKey) setAskRepoMessages(stored);
    });
    // setAskRepoMessages is a zustand action — stable across renders, safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoKey]);

  // Disconnects any in-flight stream both on unmount and whenever the user switches to
  // a different repository while this page is still mounted — a request answering a
  // question about the previous repo must never keep writing into this view.
  useEffect(() => {
    return () => {
      portRef.current?.disconnect();
      portRef.current = null;
    };
  }, [repoKey]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [askRepoMessages]);

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
    const text = askRepoInput.trim();
    if (!text || askRepoStreaming || !pageContext || !repoKey) return;

    setAskRepoInput('');
    addAskRepoMessage({ role: 'user', content: text });
    saveRepoAskMessages(repoKey, useStore.getState().askRepoMessages);

    addAskRepoMessage({ role: 'assistant', content: '' });
    setAskRepoStreaming(true);

    const port = chrome.runtime.connect({ name: 'ask-repo-stream' });
    portRef.current = port;
    port.postMessage({
      question: text,
      context: {
        repoOwner: pageContext.repoOwner,
        repoName: pageContext.repoName,
        ref: pageContext.page === 'file' ? pageContext.fileRef : undefined,
      },
    });

    port.onMessage.addListener((msg: AskRepoStreamEvent) => {
      if (msg.type === 'citations' && msg.citations) {
        setLastAskRepoMessageCitations(msg.citations);
      } else if (msg.type === 'status' && msg.indexing) {
        setLastAskRepoMessageIndexingStatus(msg.indexing);
      } else if (msg.type === 'chunk' && msg.content) {
        appendToLastAskRepoMessage(msg.content);
      } else if (msg.type === 'done' || msg.type === 'error') {
        if (msg.type === 'error') {
          appendToLastAskRepoMessage('\n\n*Error: ' + (msg.message ?? 'Unknown error') + '*');
        }
        setAskRepoStreaming(false);
        port.disconnect();
        if (portRef.current === port) portRef.current = null;
        saveRepoAskMessages(repoKey, useStore.getState().askRepoMessages);
      }
    });

    port.onDisconnect.addListener(() => setAskRepoStreaming(false));
  };

  const handleClearHistory = async () => {
    if (!repoKey) return;
    await clearRepoAskMessages(repoKey);
    resetAskRepo();
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
        {askRepoMessages.length > 0 && (
          <button
            onClick={handleClearHistory}
            disabled={askRepoStreaming}
            title="Clear ask-repository history for this repository"
            style={{
              background: 'none',
              border: 'none',
              color: C.muted,
              cursor: askRepoStreaming ? 'default' : 'pointer',
              padding: '3px 16px 3px 6px',
              borderRadius: 5,
              fontSize: 11,
              fontFamily: 'inherit',
              opacity: askRepoStreaming ? 0.4 : 1,
            }}
          >
            Clear
          </button>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {askRepoMessages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginTop: 40, padding: '0 20px', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: C.textSub }}>Ask about this repository&apos;s code.</p>
            <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              Answers are grounded in the actual source and cite the files they came from — try &ldquo;where is authentication
              implemented?&rdquo; or &ldquo;trace the login flow&rdquo;.
            </p>
          </div>
        )}

        {askRepoMessages.map((msg, i) => (
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
              {msg.role === 'assistant' && askRepoStreaming && i === askRepoMessages.length - 1 && msg.content === '' && (
                <span style={{ color: C.muted }}>Thinking…</span>
              )}
            </div>

            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {msg.citations.map((c, ci) => (
                  <a
                    key={ci}
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Open ${c.path} at line ${c.startLine} on GitHub`}
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                      fontSize: 10.5,
                      color: C.muted,
                      background: C.bgTer,
                      border: `1px solid ${C.borderMuted}`,
                      borderRadius: 5,
                      padding: '3px 7px',
                      textDecoration: 'none',
                    }}
                  >
                    {c.path}:{c.startLine}
                    {c.endLine !== c.startLine ? `-${c.endLine}` : ''}
                  </a>
                ))}
              </div>
            )}

            {msg.role === 'assistant' && msg.indexingStatus === 'partial' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: C.mutedDim }}>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: C.mutedDim,
                    flexShrink: 0,
                    animation: 'pulse 1.4s ease-in-out infinite',
                  }}
                />
                Indexing the rest of the repository in the background — later questions will draw on more of the codebase.
              </div>
            )}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.borderMuted}`, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0, background: C.bg }}>
        <textarea
          ref={textareaRef}
          value={askRepoInput}
          onChange={(e) => setAskRepoInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => e.stopPropagation()}
          placeholder="Ask about this repository's code…"
          rows={1}
          disabled={askRepoStreaming}
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
          disabled={!askRepoInput.trim() || askRepoStreaming}
          style={{
            width: 34,
            height: 34,
            background: askRepoInput.trim() && !askRepoStreaming ? C.accent : C.bgTer,
            color: askRepoInput.trim() && !askRepoStreaming ? C.bg : C.muted,
            border: `1px solid ${askRepoInput.trim() && !askRepoStreaming ? C.accent : C.borderMuted}`,
            borderRadius: '50%',
            fontSize: 14,
            cursor: askRepoInput.trim() && !askRepoStreaming ? 'pointer' : 'default',
            fontFamily: 'inherit',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.15s, border-color 0.15s',
          }}
        >
          {askRepoStreaming ? (
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
