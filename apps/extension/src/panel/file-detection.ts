import { useStore } from './store';
import { parseFileRouteFromUrl, extractFileContentFromDom, isFileContentReady, resolveFileRoute } from '../content/page-parser';
import type { FileRouteInfo } from '../content/page-parser';
import { fetchRawFileContent } from '../content/fetch-file';
import { devLog } from './dev-log';

export type { FileRouteInfo };
export { parseFileRouteFromUrl };

const HARD_TIMEOUT_MS = 3000;

let navId = 0;
let activeObserver: MutationObserver | null = null;
let activeHardTimeout: ReturnType<typeof setTimeout> | null = null;

function log(navStart: number, msg: string) {
  devLog(`${msg} at ${Math.round(performance.now() - navStart)}ms`);
}

function teardown() {
  if (activeObserver) {
    activeObserver.disconnect();
    activeObserver = null;
  }
  if (activeHardTimeout) {
    clearTimeout(activeHardTimeout);
    activeHardTimeout = null;
  }
}

/**
 * Runs whenever navigation lands on a new file route (URL parsed synchronously by the
 * caller — no DOM dependency). Races a direct raw-content fetch against a targeted DOM
 * observer scoped to the file container; whichever produces usable content first wins,
 * and the loser is torn down. A monotonic navId guards every async callback so a stale
 * navigation (the user already moved to a different file) can never overwrite the
 * current one, and only one observer/fetch is ever active at a time.
 *
 * `route` is the naive, URL-only guess (ref = first path segment). It's corrected
 * against GitHub's embedded page data (`resolveFileRoute`) wherever that data might
 * already be available — immediately, on every DOM mutation, and again right before
 * trusting a raw-fetch result — so a slash-containing branch name never produces wrong
 * content or a wrong cache key, even though it's what makes the URL itself ambiguous.
 */
export function startFileDetection(route: FileRouteInfo, navStart: number): void {
  const myNavId = ++navId;
  teardown();

  const { setPageContext, setFileStage, setFileNavStartedAt } = useStore.getState();
  setFileStage('file_detected');
  setFileNavStartedAt(navStart);

  let resolved = resolveFileRoute(route);

  const applyContent = (content: string, source: string) => {
    if (myNavId !== navId) return; // a newer navigation has since started — ignore
    teardown();
    const current = useStore.getState().pageContext;
    if (!current || current.page !== 'file' || current.filePath !== route.filePath) return;
    const corrected = resolved.ref !== route.ref || resolved.filePath !== route.filePath;
    log(navStart, `content extracted via ${source}${corrected ? ' (ref/path corrected via embedded page data)' : ''}`);
    setPageContext({ ...current, filePath: resolved.filePath, fileRef: resolved.ref, fileContent: content });
    useStore.getState().setFileStage('content_extracted');
  };

  // Immediate check — content may already be rendered (e.g. back/forward navigation
  // that GitHub served from bfcache), so a fetch/observer may not even be needed.
  const immediate = extractFileContentFromDom();
  if (isFileContentReady(immediate)) {
    applyContent(immediate, 'DOM (already rendered)');
    return;
  }

  setFileStage('waiting_for_content');

  // Targeted observer — only the file content container, not the whole document —
  // disconnected the moment content shows up (or a newer navigation starts).
  const container =
    document.querySelector('#repo-content-pjax-container') ?? document.querySelector('main') ?? document.body;

  activeObserver = new MutationObserver(() => {
    if (myNavId !== navId) return;
    resolved = resolveFileRoute(route); // refine as more of the page becomes available
    const content = extractFileContentFromDom();
    if (isFileContentReady(content)) applyContent(content, 'DOM observer');
  });
  activeObserver.observe(container, { childList: true, subtree: true });

  // Primary path: fetch the raw file directly, using whatever ref/path is resolved
  // *right now*. This runs concurrently with the DOM observer above (not after a
  // timeout) since it's normally the faster of the two.
  const fetchTarget = resolved;
  log(navStart, 'raw fetch started');
  fetchRawFileContent(fetchTarget.repoOwner, fetchTarget.repoName, fetchTarget.ref, fetchTarget.filePath).then((raw) => {
    if (myNavId !== navId) return;

    // Re-resolve before trusting this result — embedded page data may have appeared
    // while the fetch was in flight and revealed the ref/path we fetched was wrong
    // (only possible for a slash-containing ref). A raw fetch against a wrong-but-
    // real ref/path combination could otherwise silently succeed with the wrong
    // file's content, so a mismatch here means "discard, let the DOM observer —
    // which reads whatever GitHub itself rendered and is never ref-ambiguous — supply
    // the content instead."
    resolved = resolveFileRoute(route);
    if (resolved.ref !== fetchTarget.ref || resolved.filePath !== fetchTarget.filePath) {
      log(navStart, 'raw fetch used a since-corrected ref/path — discarding, relying on DOM');
      return;
    }

    if (raw && isFileContentReady(raw)) {
      log(navStart, 'raw fetch completed');
      applyContent(raw, 'raw fetch');
    } else {
      log(navStart, 'raw fetch failed or returned no usable content — relying on DOM observer');
    }
  });

  // Diagnostic hard timeout: the DOM observer keeps running past this point in case of
  // an unusually slow render, but this makes a stall visible in the console instead of
  // silently sitting with no signal about where time is going.
  activeHardTimeout = setTimeout(() => {
    if (myNavId !== navId) return;
    const current = useStore.getState().pageContext;
    if (current?.page === 'file' && !isFileContentReady(current.fileContent)) {
      log(navStart, 'hard timeout reached — still waiting on DOM observer');
    }
  }, HARD_TIMEOUT_MS);
}

/** Call when navigating away from a file page entirely, so no observer/fetch is left
 * running for content that's no longer relevant. */
export function cancelFileDetection(): void {
  navId++;
  teardown();
}
