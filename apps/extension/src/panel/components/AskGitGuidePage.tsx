import { useEffect, useRef, KeyboardEvent } from 'react';
import { useStore, ChatMessage, IndexInfo } from '../store';
import { sendChatMessage, stopChat, retryAnswer, clearConversation } from '../chat';
import { BackButton, SC as C } from './shared';
import { Markdown } from './Markdown';

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 7) : '';
}

function IndexNote({ index }: { index: IndexInfo }) {
  const where = `${index.ref}${index.commitSha ? ` @ ${shortSha(index.commitSha)}` : ''}`;
  const searchKind = index.retrieval === 'hybrid' ? 'keyword + semantic search' : 'keyword search';
  let coverage: string;
  if (index.fullCoverage) coverage = `searched all ${index.indexedFiles} indexed files`;
  else {
    coverage = `searched ${index.indexedFiles} of ${index.eligibleFiles} files`;
    if (index.treeTruncated) coverage += ' (GitHub truncated the file list)';
  }
  const stillIndexing = index.status === 'partial' || index.status === 'background-indexing';
  return (
    <div style={{ fontSize: 10.5, color: C.mutedDim, lineHeight: 1.5 }}>
      Based on {where} · {coverage} · {searchKind}
      {stillIndexing && ' · indexing more files in the background, later questions will see more'}
      {index.status === 'failed' && ' · background indexing stopped early; GitGuide will retry later'}
    </div>
  );
}

function StatusNote({ message, isLast, streaming }: { message: ChatMessage; isLast: boolean; streaming: boolean }) {
  const canRetry = isLast && !streaming && (message.status === 'error' || message.status === 'interrupted' || message.status === 'stopped');
  let text: string | null = null;
  let tone: string = C.mutedDim;
  if (message.status === 'error') {
    text = message.error?.message ?? 'Something went wrong.';
    tone = '#f85149';
  } else if (message.status === 'interrupted') {
    text = 'The answer was interrupted before it finished.';
    tone = '#d29922';
  } else if (message.status === 'stopped') {
    text = 'Stopped.';
  } else if (message.status === 'complete' && message.finishReason === 'length') {
    text = 'The answer reached the length limit and may be incomplete.';
    tone = '#d29922';
  }
  if (!text && !canRetry) return null;
  return (
    <div role={message.status === 'error' ? 'alert' : undefined} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: tone }}>
      {text && <span>{text}</span>}
      {canRetry && (
        <button type="button" className="gg-linkbtn" onClick={() => retryAnswer(message.id)} style={{ border: `1px solid ${C.border}` }}>
          Retry
        </button>
      )}
    </div>
  );
}

export function AskGitGuidePage() {
  const { pageContext, goToQuickActions, chatMessages, chatInput, chatStreaming, chatHydrated, chatStorageWarning, setChatInput } = useStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [chatMessages]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  if (!pageContext) return null;

  const handleSend = () => {
    const result = sendChatMessage(chatInput);
    // The Send button is replaced by Stop while streaming; keep focus in the panel.
    textareaRef.current?.focus();
    if (result === 'private' && statusRef.current) {
      statusRef.current.textContent = 'GitGuide works with public repositories only, so nothing was sent.';
    }
  };

  // GitHub never sees these keys (see content/keyboard-guard.ts), so Escape is allowed to
  // bubble up to the panel, which closes it.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const lastAssistant = [...chatMessages].reverse().find((m) => m.role === 'assistant' && m.index?.ref);
  const viewingRef = pageContext.page === 'file' ? pageContext.fileRef : undefined;
  const refChanged = !!(viewingRef && lastAssistant?.index && lastAssistant.index.ref !== viewingRef);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{ borderBottom: `1px solid ${C.borderMuted}`, display: 'flex', alignItems: 'center', flexShrink: 0, background: C.bgSec }}>
        <BackButton onClick={goToQuickActions} />
        <span style={{ color: C.muted, fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pageContext.repoOwner}/{pageContext.repoName}
        </span>
        {chatMessages.length > 0 && (
          <button
            type="button"
            className="gg-linkbtn"
            onClick={() => void clearConversation()}
            disabled={chatStreaming}
            title="Delete this repository's conversation from this device"
            style={{ marginRight: 10, opacity: chatStreaming ? 0.4 : 1, fontSize: 11 }}
          >
            Clear
          </button>
        )}
      </div>

      <div
        role="log"
        aria-live="polite"
        aria-busy={chatStreaming}
        aria-label="Conversation"
        style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {!chatHydrated && chatMessages.length === 0 && <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>Loading conversation…</p>}
        {chatHydrated && chatMessages.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', marginTop: 40, padding: '0 20px', gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: C.textSub }}>Ask GitGuide about this repository&apos;s code.</p>
            <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.6 }}>
              Answers are based on excerpts GitGuide finds in the public source, with links to the exact lines. When the excerpts
              don&apos;t show something, it will say so. Try &ldquo;where is authentication implemented?&rdquo;
            </p>
          </div>
        )}

        {chatMessages.map((msg, i) => {
          const isLast = i === chatMessages.length - 1;
          return (
            <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: msg.role === 'user' ? C.accent : '#6e7681', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
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
                }}
              >
                {msg.role === 'user' ? (
                  <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</span>
                ) : msg.content ? (
                  <Markdown text={msg.content} />
                ) : msg.status === 'streaming' ? (
                  <span style={{ color: C.muted }}>{msg.index ? 'Thinking…' : 'Reading the repository…'}</span>
                ) : (
                  <span style={{ color: C.mutedDim }}>No answer.</span>
                )}
              </div>

              {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} aria-label="Sources">
                  {msg.citations.map((c, ci) => (
                    <a
                      key={ci}
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Open ${c.path} lines ${c.startLine}–${c.endLine} on GitHub (new tab)`}
                      style={{
                        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                        fontSize: 10.5,
                        color: C.muted,
                        background: C.bgTer,
                        border: `1px solid ${C.borderMuted}`,
                        borderRadius: 5,
                        padding: '3px 7px',
                        textDecoration: 'underline',
                        textDecorationColor: C.border,
                        wordBreak: 'break-all',
                      }}
                    >
                      [{ci + 1}] {c.path}:{c.startLine}
                      {c.endLine !== c.startLine ? `-${c.endLine}` : ''}
                    </a>
                  ))}
                </div>
              )}
              {msg.role === 'assistant' && msg.index && msg.status !== 'error' && <IndexNote index={msg.index} />}
              {msg.role === 'assistant' && <StatusNote message={msg} isLast={isLast} streaming={chatStreaming} />}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {(refChanged || chatStorageWarning) && (
        <div style={{ padding: '6px 14px', fontSize: 11, color: '#d29922', borderTop: `1px solid ${C.borderMuted}`, lineHeight: 1.5 }} role="status">
          {refChanged && <div>Earlier answers were about {lastAssistant?.index?.ref}. New questions will use {viewingRef}.</div>}
          {chatStorageWarning && <div>{chatStorageWarning}</div>}
        </div>
      )}
      <p ref={statusRef} role="status" className="gg-sr-only" />

      <div style={{ padding: '10px 14px', borderTop: `1px solid ${C.borderMuted}`, display: 'flex', gap: 8, alignItems: 'flex-end', flexShrink: 0, background: C.bg }}>
        <label htmlFor="gg-chat-input" className="gg-sr-only">
          Ask about this repository
        </label>
        <textarea
          id="gg-chat-input"
          ref={textareaRef}
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about this repository's code…"
          rows={1}
          maxLength={2000}
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
            lineHeight: 1.5,
            minHeight: 36,
            maxHeight: 120,
            overflowY: 'auto',
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 120) + 'px';
          }}
        />
        {chatStreaming ? (
          <button
            type="button"
            onClick={() => {
              stopChat();
              textareaRef.current?.focus();
            }}
            aria-label="Stop generating"
            title="Stop generating"
            style={{
              height: 34,
              padding: '0 12px',
              background: C.bgTer,
              color: C.text,
              border: `1px solid ${C.border}`,
              borderRadius: 17,
              fontSize: 12,
              cursor: 'pointer',
              fontFamily: 'inherit',
              flexShrink: 0,
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!chatInput.trim()}
            aria-label="Send message"
            title="Send message"
            style={{
              width: 34,
              height: 34,
              background: chatInput.trim() ? C.accent : C.bgTer,
              color: chatInput.trim() ? C.bg : C.muted,
              border: `1px solid ${chatInput.trim() ? C.accent : C.borderMuted}`,
              borderRadius: '50%',
              cursor: chatInput.trim() ? 'pointer' : 'default',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
