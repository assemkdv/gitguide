import React, { useEffect, useRef, useState } from 'react';
import { useStore, repoKeyOf } from './store';
import { EmptyState } from './components/EmptyState';
import { HomeView } from './components/HomeView';
import { ResultPage } from './components/ResultPage';
import { ChatPage } from './components/ChatPage';
import { parseGitHubPage } from '../content/page-parser';
import { parseFileRouteFromUrl, startFileDetection, cancelFileDetection } from './file-detection';
import { devLog } from './dev-log';
import { pruneExpiredCache } from './storage';

const C = {
  bg: '#0d1117',
  bgSec: '#161b22',
  bgTer: '#1c2128',
  border: '#30363d',
  borderMuted: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
  accent: '#E7E9EE',
  accentText: '#E7E9EE',
  logoBg: 'linear-gradient(135deg, #171b2e 0%, #0a0b12 100%)',
} as const;

const MIN_WIDTH = 320;
const MAX_WIDTH = 650;
const DEFAULT_WIDTH = 400;

function LogoGlyph({ size = 14, color = C.accentText }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M46 76 L24 50 L46 24 L78 22"
        stroke={color}
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="78" cy="22" r="8.5" fill={color} />
    </svg>
  );
}

function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: C.logoBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <LogoGlyph size={size * 0.6} />
    </div>
  );
}

function LogoIcon({ size = 20, color = C.accentText }: { size?: number; color?: string }) {
  return <LogoGlyph size={size} color={color} />;
}

export default function App() {
  const { isOpen, view, pageContext, setOpen, setView, setPageContext } = useStore();

  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('gitguide-panel-width');
      return saved ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parseInt(saved, 10))) : DEFAULT_WIDTH;
    } catch {
      return DEFAULT_WIDTH;
    }
  });

  const [handleHovered, setHandleHovered] = useState(false);
  const isDraggingRef = useRef(false);
  const panelWidthRef = useRef(panelWidth);
  useEffect(() => {
    panelWidthRef.current = panelWidth;
  }, [panelWidth]);

  const pushStyleRef = useRef<HTMLStyleElement | null>(null);

  useEffect(() => {
    let el = document.getElementById('gitguide-push') as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = 'gitguide-push';
      document.head.appendChild(el);
    }
    pushStyleRef.current = el;
    return () => {
      pushStyleRef.current?.remove();
      pushStyleRef.current = null;
    };
  }, []);

  useEffect(() => {
    const el = pushStyleRef.current;
    if (!el) return;
    el.textContent = isOpen
      ? `body { margin-right: ${panelWidthRef.current}px !important; transition: margin-right 0.25s ease; }`
      : `body { margin-right: 0px !important; transition: margin-right 0.25s ease; }`;
  }, [isOpen]);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;

    isDraggingRef.current = true;
    setHandleHovered(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - ev.clientX)));
      setPanelWidth(newWidth);
      if (pushStyleRef.current) {
        pushStyleRef.current.textContent = `body { margin-right: ${newWidth}px !important; }`;
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      setHandleHovered(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('gitguide-panel-width', String(panelWidthRef.current));
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // File routes are resolved from the URL alone (see file-detection.ts) — no DOM
  // access, so this branch runs and updates state before GitHub has painted anything.
  const updateFilePageContext = (fileRoute: NonNullable<ReturnType<typeof parseFileRouteFromUrl>>, navStart: number) => {
    const { pageContext: prev, resetResults, resetChat, setFileResult, setFileQuickResult, setFileError } =
      useStore.getState();

    const prevRepoKey = prev ? repoKeyOf(prev.repoOwner, prev.repoName) : null;
    const nextRepoKey = repoKeyOf(fileRoute.repoOwner, fileRoute.repoName);
    const unchanged = prev?.page === 'file' && prevRepoKey === nextRepoKey && prev.filePath === fileRoute.filePath;
    if (unchanged) return; // Same file as before — don't restart detection or clobber in-flight content.

    devLog(`file route parsed at ${Math.round(performance.now() - navStart)}ms`);

    const next: NonNullable<typeof prev> = {
      repoOwner: fileRoute.repoOwner,
      repoName: fileRoute.repoName,
      page: 'file',
      filePath: fileRoute.filePath,
      fileRef: fileRoute.ref,
      fileContent: '',
    };
    setPageContext(next);
    devLog(`file state updated at ${Math.round(performance.now() - navStart)}ms`);

    if (prevRepoKey !== nextRepoKey) {
      resetResults();
      resetChat();
      setView('home');
    } else {
      setFileResult(null);
      setFileQuickResult(null);
      setFileError(null);
    }

    startFileDetection(fileRoute, navStart);
  };

  const updatePageContext = () => {
    const navStart = performance.now();

    // File pages are handled entirely from the URL, independent of DOM/render speed.
    const fileRoute = parseFileRouteFromUrl();
    if (fileRoute) {
      updateFilePageContext(fileRoute, navStart);
      return;
    }

    // Not a file route — make sure no stale file-detection work keeps running.
    cancelFileDetection();

    const info = parseGitHubPage();
    const { pageContext: prev, resetResults, resetChat, setIssueResult, setIssueError } = useStore.getState();

    if (!info.isRepoPage) {
      setPageContext(null);
      setView('empty');
      return;
    }

    let next: NonNullable<typeof prev>;
    if (info.isIssuePage) {
      // If the URL just changed to a *different* issue number, the DOM read above may
      // still reflect the previous issue for a beat (GitHub's SPA hasn't repainted yet).
      // Trusting it here would let a stale title/body sail through the "ready" checks
      // and never get corrected. Force it blank instead so downstream ready-checks stay
      // false; pollPendingContent below re-parses in place until the real content for
      // this issue number lands.
      const switchingIssue = prev?.page === 'issue' && prev.issueNumber !== info.issueNumber;
      next = {
        repoOwner: info.repoOwner,
        repoName: info.repoName,
        page: 'issue',
        issueNumber: info.issueNumber,
        issueTitle: switchingIssue ? '' : info.issueTitle,
        issueBody: switchingIssue ? '' : info.issueBody,
        issueComments: switchingIssue ? '' : info.issueComments,
      };
    } else {
      next = { repoOwner: info.repoOwner, repoName: info.repoName, page: 'repo' };
    }

    setPageContext(next);

    const prevRepoKey = prev ? repoKeyOf(prev.repoOwner, prev.repoName) : null;
    const nextRepoKey = repoKeyOf(next.repoOwner, next.repoName);

    if (prevRepoKey !== nextRepoKey) {
      // Switched to a different repository entirely — nothing carries over.
      resetResults();
      resetChat();
      setView('home');
      return;
    }

    // Same repo: drop a stale in-memory result for the *previous* issue. If the user
    // is still looking at that result page, ResultPage's own auto-detect effect picks
    // up the new target and re-analyzes automatically — no need to bounce back to
    // Quick Actions or ask them to click anything again.
    if (prev?.page === 'issue' && next.page === 'issue' && prev.issueNumber !== next.issueNumber) {
      setIssueResult(null);
      setIssueError(null);
    }
  };

  // Best-effort, once per mount — not on every navigation — so storage.local doesn't
  // accumulate stale cache entries from files/issues/repos browsed in past sessions.
  useEffect(() => {
    pruneExpiredCache();
  }, []);

  useEffect(() => {
    updatePageContext();

    let lastUrl = location.href;

    const checkNav = () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        devLog('URL change detected');
        updatePageContext();
      }
    };

    // Same URL, but the issue DOM may still be mid-render (GitHub's React UI paints
    // the title/body a beat after the URL settles). Re-parse in place until the
    // content actually shows up, so ResultPage's auto-detect effect can fire the
    // moment it's ready instead of the user needing to reload or retry. Driven by a
    // MutationObserver (fires the instant the DOM actually changes) rather than a
    // fixed-interval poll. File content readiness is handled separately by
    // file-detection.ts's own targeted observer/raw fetch, so it's excluded here.
    let pendingContentTimer: ReturnType<typeof setTimeout> | null = null;
    const pollPendingContent = () => {
      const current = useStore.getState().pageContext;
      if (!current) return;
      const needsIssueContent = current.page === 'issue' && !current.issueTitle;
      if (!needsIssueContent) return;
      if (pendingContentTimer) return;
      // Small debounce so a burst of unrelated mutations mid-render doesn't trigger a
      // re-parse on every single tick.
      pendingContentTimer = setTimeout(() => {
        pendingContentTimer = null;
        updatePageContext();
      }, 50);
    };

    // 'gitguide:navigation' is dispatched by a MAIN-world patch on history.pushState/
    // replaceState (see content/nav-patch.ts) — GitHub's own SPA router is invisible to
    // this isolated-world script otherwise. turbo:load/pjax:end, the MutationObserver,
    // and the interval below are kept as fallbacks for navigation styles that don't go
    // through pushState.
    window.addEventListener('gitguide:navigation', checkNav);
    document.addEventListener('turbo:load', updatePageContext);
    document.addEventListener('pjax:end', updatePageContext);
    window.addEventListener('popstate', checkNav);

    const observer = new MutationObserver(pollPendingContent);
    observer.observe(document.body, { childList: true, subtree: true });

    // Rare-case safety net only — checks a cheap string comparison, not a full DOM
    // re-parse, so it's not the "broad polling" this replaces.
    const interval = setInterval(checkNav, 1000);

    return () => {
      observer.disconnect();
      if (pendingContentTimer) clearTimeout(pendingContentTimer);
      window.removeEventListener('gitguide:navigation', checkNav);
      document.removeEventListener('turbo:load', updatePageContext);
      document.removeEventListener('pjax:end', updatePageContext);
      window.removeEventListener('popstate', checkNav);
      clearInterval(interval);
    };
    // updatePageContext is intentionally omitted — it's redefined every render, and
    // this effect must only register its listeners once on mount, not on every
    // pageContext-driven re-render (which would tear down and reattach on every
    // navigation, defeating the point of the listeners).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #484f58; border-radius: 99px; }
      `}</style>

      {/* Floating toggle button */}
      <button
        onClick={() => setOpen(!isOpen)}
        title={isOpen ? 'Close GitGuide' : 'Open GitGuide'}
        style={{
          position: 'fixed',
          bottom: 20,
          right: isOpen ? panelWidth + 12 : 20,
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: C.logoBg,
          border: `1px solid ${C.border}`,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 1px 6px rgba(0,0,0,0.5)',
          transition: 'right 0.25s ease, background 0.15s',
          zIndex: 2147483647,
          fontFamily: 'system-ui, sans-serif',
          pointerEvents: 'all',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = '#1c2033';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.background = C.logoBg;
        }}
      >
        {isOpen ? (
          <span style={{ fontSize: 16, lineHeight: 1, marginTop: -1, color: C.accentText }}>←</span>
        ) : (
          <LogoIcon size={20} />
        )}
      </button>

      {/* Resize handle — stays mounted (not conditionally rendered on isOpen) so the
          panel below can keep its own state (scroll position, retry handlers) across
          open/close toggles instead of remounting from scratch every time. */}
      <div
        onMouseDown={handleResizeMouseDown}
        onMouseEnter={() => setHandleHovered(true)}
        onMouseLeave={() => {
          if (!isDraggingRef.current) setHandleHovered(false);
        }}
        style={{
          position: 'fixed',
          top: 0,
          right: panelWidth - 4,
          width: 8,
          height: '100vh',
          cursor: 'ew-resize',
          zIndex: 2147483648,
          pointerEvents: isOpen ? 'all' : 'none',
          display: isOpen ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 2,
            height: 40,
            borderRadius: 99,
            background: handleHovered ? C.accent : 'transparent',
            transition: 'background 0.15s ease',
          }}
        />
      </div>

      {/* Panel */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: panelWidth,
          height: '100vh',
          background: C.bg,
          borderLeft: `1px solid ${C.border}`,
          borderRadius: '12px 0 0 12px',
          display: isOpen ? 'flex' : 'none',
          flexDirection: 'column',
          zIndex: 2147483646,
          animation: 'slideIn 0.2s ease',
          overflow: 'hidden',
          fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          color: C.text,
          pointerEvents: isOpen ? 'all' : 'none',
        }}
      >
        {/* Panel header */}
        <div
          style={{
            height: 44,
            padding: '0 14px',
            borderBottom: `1px solid ${C.border}`,
            background: C.bgSec,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <LogoMark size={26} />
            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 1 }}>
              <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em', lineHeight: 1.2 }}>GitGuide</span>
              {pageContext && (
                <span
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 10.5,
                    color: C.muted,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#3fb950',
                      flexShrink: 0,
                      animation: 'pulse 1.8s ease-in-out infinite',
                    }}
                  />
                  {pageContext.page === 'issue' && pageContext.issueNumber
                    ? `${pageContext.repoOwner}/${pageContext.repoName} · Issue #${pageContext.issueNumber}`
                    : pageContext.page === 'file' && pageContext.filePath
                      ? `File: ${pageContext.filePath}`
                      : `Reading ${pageContext.repoOwner}/${pageContext.repoName}`}
                </span>
              )}
            </div>
          </div>

          <button
            onClick={() => setOpen(false)}
            style={{
              background: 'none',
              border: 'none',
              color: C.muted,
              cursor: 'pointer',
              fontSize: 17,
              lineHeight: 1,
              padding: '4px 6px',
              borderRadius: 6,
              fontFamily: 'inherit',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = C.text;
              e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = C.muted;
              e.currentTarget.style.background = 'none';
            }}
            title="Close"
          >
            ×
          </button>
        </div>

        {/* View content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {view === 'home' && <HomeView />}
          {view === 'result' && <ResultPage />}
          {view === 'chat' && <ChatPage />}
          {view === 'empty' && <EmptyState />}
        </div>
      </div>
    </>
  );
}
