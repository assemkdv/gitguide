import React, { useEffect, useRef, useState } from 'react';
import { useStore, repoKeyOf, PanelView } from './store';
import { EmptyState } from './components/EmptyState';
import { HomeView } from './components/HomeView';
import { ResultPage } from './components/ResultPage';
import { AskGitGuidePage } from './components/AskGitGuidePage';
import { DataNotice, SettingsView } from './components/DataNotice';
import { MARKDOWN_CSS } from './components/Markdown';
import { parseGitHubPage } from '../content/page-parser';
import { parseFileRouteFromUrl, startFileDetection, cancelFileDetection, isSameFileRoute } from './file-detection';
import { devLog } from './dev-log';
import { pruneExpiredCache, loadConsent, loadPanelWidth, savePanelWidth, sanitizePanelWidth, DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH } from './storage';
import { hydrateChat } from './chat';
import { openSettings } from './actions';

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

const LEGACY_WIDTH_KEY = 'gitguide-panel-width';
/** Below this window width the panel overlays the page instead of squeezing it. */
const OVERLAY_BREAKPOINT = 760;

/** After a repository change, views tied to the old page go back to Quick Actions;
 * the consent and settings screens stay where they are. */
function viewAfterRepoChange(view: PanelView): PanelView {
  return view === 'consent' || view === 'settings' ? view : 'home';
}

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

  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [preferredWidth, setPreferredWidth] = useState(DEFAULT_PANEL_WIDTH);
  const panelWidth = sanitizePanelWidth(preferredWidth, viewportWidth);
  const overlay = viewportWidth < OVERLAY_BREAKPOINT;
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Saved width lives in extension storage. Older versions kept it in github.com's own
  // localStorage; migrate it once (sanitized — a corrupted value used to produce NaN)
  // and remove it from the page's storage.
  useEffect(() => {
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem(LEGACY_WIDTH_KEY);
      if (legacy != null) localStorage.removeItem(LEGACY_WIDTH_KEY);
    } catch {
      // Page storage unavailable — nothing to migrate.
    }
    void loadPanelWidth().then((saved) => {
      if (saved != null) setPreferredWidth(saved);
      else if (legacy != null) {
        const migrated = sanitizePanelWidth(legacy);
        setPreferredWidth(migrated);
        void savePanelWidth(migrated);
      }
    });
    void loadConsent().then((accepted) => useStore.setState({ consentAccepted: accepted, consentLoaded: true }));
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Focus moves into the panel when it opens and back to the launcher when it closes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen && !wasOpen.current) panelRef.current?.focus();
    if (!isOpen && wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen]);

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
    // On narrow windows the panel overlays the page rather than squeezing GitHub's layout.
    el.textContent =
      isOpen && !overlay
        ? `body { margin-right: ${panelWidthRef.current}px !important; transition: margin-right 0.25s ease; }`
        : '';
  }, [isOpen, overlay, panelWidth]);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidthRef.current;

    isDraggingRef.current = true;
    setHandleHovered(true);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = sanitizePanelWidth(startWidth + (startX - ev.clientX), window.innerWidth);
      setPreferredWidth(newWidth);
      if (pushStyleRef.current && window.innerWidth >= OVERLAY_BREAKPOINT) {
        pushStyleRef.current.textContent = `body { margin-right: ${newWidth}px !important; }`;
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      setHandleHovered(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      void savePanelWidth(panelWidthRef.current);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleResizeKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 50 : 10;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = panelWidth + step;
    if (e.key === 'ArrowRight') next = panelWidth - step;
    if (e.key === 'Home') next = MAX_PANEL_WIDTH;
    if (e.key === 'End') next = MIN_PANEL_WIDTH;
    if (next == null) return;
    e.preventDefault();
    const width = sanitizePanelWidth(next, window.innerWidth);
    setPreferredWidth(width);
    void savePanelWidth(width);
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    }
  };

  // File routes are resolved from the URL alone (see file-detection.ts) — no DOM
  // access, so this branch runs and updates state before GitHub has painted anything.
  const updateFilePageContext = (fileRoute: NonNullable<ReturnType<typeof parseFileRouteFromUrl>>, navStart: number) => {
    const { pageContext: prev, resetResults, resetFileResult } = useStore.getState();

    const prevRepoKey = prev ? repoKeyOf(prev.repoOwner, prev.repoName) : null;
    const nextRepoKey = repoKeyOf(fileRoute.repoOwner, fileRoute.repoName);
    if (isSameFileRoute(prev, fileRoute)) return; // Same file as before — don't restart detection or clobber in-flight content.

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
      void hydrateChat(nextRepoKey);
      setView(viewAfterRepoChange(useStore.getState().view));
    } else {
      resetFileResult();
    }

    startFileDetection(fileRoute, navStart, {
      // No previous context means the panel just mounted on a freshly loaded page.
      inPlaceNavigation: prev !== null,
      previousContent: prev?.page === 'file' ? prev.fileContent : undefined,
    });
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
    const { pageContext: prev, resetResults, resetIssueResult } = useStore.getState();

    if (!info.isRepoPage) {
      setPageContext(null);
      void hydrateChat(null);
      const current = useStore.getState().view;
      setView(current === 'settings' ? current : 'empty');
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
      void hydrateChat(nextRepoKey);
      setView(viewAfterRepoChange(useStore.getState().view));
      return;
    }

    // Same repo: drop a stale in-memory result for the *previous* issue. If the user
    // is still looking at that result page, ResultPage's own auto-detect effect picks
    // up the new target and re-analyzes automatically — no need to bounce back to
    // Quick Actions or ask them to click anything again.
    if (prev?.page === 'issue' && next.page === 'issue' && prev.issueNumber !== next.issueNumber) {
      resetIssueResult();
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
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
        ${MARKDOWN_CSS}
      `}</style>

      {/* Floating toggle button */}
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen(!isOpen)}
        title={isOpen ? 'Close GitGuide' : 'Open GitGuide'}
        aria-label={isOpen ? 'Close GitGuide panel' : 'Open GitGuide panel'}
        aria-expanded={isOpen}
        aria-controls="gitguide-panel"
        style={{
          position: 'fixed',
          bottom: 20,
          right: isOpen && !overlay ? panelWidth + 12 : 20,
          display: isOpen && overlay ? 'none' : 'flex',
          width: 40,
          height: 40,
          borderRadius: '50%',
          background: C.logoBg,
          border: `1px solid ${C.border}`,
          cursor: 'pointer',
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
          <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1, marginTop: -1, color: C.accentText }}>→</span>
        ) : (
          <LogoIcon size={20} />
        )}
      </button>

      {/* Resize handle — stays mounted (not conditionally rendered on isOpen) so the
          panel below can keep its own state (scroll position, retry handlers) across
          open/close toggles instead of remounting from scratch every time. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize GitGuide panel"
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={MAX_PANEL_WIDTH}
        aria-valuenow={panelWidth}
        tabIndex={isOpen ? 0 : -1}
        onKeyDown={handleResizeKeyDown}
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
          zIndex: 2147483647,
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
        id="gitguide-panel"
        ref={panelRef}
        role="complementary"
        aria-label="GitGuide"
        tabIndex={-1}
        onKeyDown={handlePanelKeyDown}
        style={{
          outline: 'none',
          maxWidth: '100vw',
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

          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          <button
            type="button"
            onClick={openSettings}
            aria-label="Privacy and data settings"
            title="Privacy & data"
            style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: '4px 6px', borderRadius: 6, display: 'flex' }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 1.5 L13.5 3.5 V7.5 C13.5 11 11 13.5 8 14.5 C5 13.5 2.5 11 2.5 7.5 V3.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Close GitGuide panel"
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
            title="Close (Esc)"
          >
            ×
          </button>
          </div>
        </div>

        {/* View content */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {view === 'home' && <HomeView />}
          {view === 'result' && <ResultPage />}
          {view === 'chat' && <AskGitGuidePage />}
          {view === 'empty' && <EmptyState />}
          {view === 'consent' && <DataNotice />}
          {view === 'settings' && <SettingsView />}
        </div>
      </div>
    </>
  );
}
