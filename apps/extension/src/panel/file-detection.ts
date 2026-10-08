import { useStore, repoKeyOf } from './store';
import type { PageContext } from './store';
import {
  parseFileRouteFromUrl,
  extractFileContentFromDom,
  isFileContentReady,
  resolveFileRoute,
  resolveRefFromKnownNames,
} from '../content/page-parser';
import type { FileRouteInfo } from '../content/page-parser';
import { fetchRawFileContent } from '../content/fetch-file';
import { getRefNames } from '../content/refs-api';
import { devLog } from './dev-log';

export type { FileRouteInfo };
export { parseFileRouteFromUrl };

/** True when `route` is the same file page as `prev` (same repo, path, and ref) — the
 * navigation is a no-op and any in-flight detection/content for it should be left alone
 * rather than restarted. Ref must match too: a file at the same path on a different
 * branch/tag is a different file, not a re-render of the current one. */
export function isSameFileRoute(prev: PageContext | null, route: FileRouteInfo): boolean {
  return (
    prev?.page === 'file' &&
    repoKeyOf(prev.repoOwner, prev.repoName) === repoKeyOf(route.repoOwner, route.repoName) &&
    prev.filePath === route.filePath &&
    prev.fileRef === route.ref
  );
}

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
 * If that still leaves the naive guess uncorrected and the initial raw fetch fails,
 * there's one more fallback: check the URL segments against the repo's actual
 * branch/tag names via GitHub's API (`getRefNames`/`resolveRefFromKnownNames`) — this
 * only fires in that specific failure case, so it doesn't cost anything for the common
 * (non-slash-branch) path.
 */
export interface FileDetectionOptions {
  /** The page changed in place (SPA navigation) rather than loading fresh. Until GitHub
   * repaints, the DOM still shows the previous page, so a DOM read that matches what was
   * on screen at navigation time is the previous file, not this one. */
  inPlaceNavigation?: boolean;
  /** Content detected for the previous file page, if any — never valid for this one. */
  previousContent?: string;
}

export function startFileDetection(route: FileRouteInfo, navStart: number, options: FileDetectionOptions = {}): void {
  const myNavId = ++navId;
  teardown();

  // Content must belong to *this* file: it's fingerprinted with the cached explanation,
  // so a stale read files this file's answer under another file's content and makes
  // later visits miss the cache (or hit it for changed content).
  const staleDom = options.inPlaceNavigation ? extractFileContentFromDom() : null;
  const isStale = (content: string) =>
    (staleDom !== null && content === staleDom) || (!!options.previousContent && content === options.previousContent);
  const domContentIfCurrent = () => {
    const content = extractFileContentFromDom();
    return isFileContentReady(content) && !isStale(content) ? content : null;
  };

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

  // Immediate check — on a fresh page load the server-rendered content is already
  // there, so a fetch/observer may not even be needed. After an in-place navigation the
  // DOM still shows the previous page, which isStale rejects.
  const immediate = domContentIfCurrent();
  if (immediate) {
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
    const content = domContentIfCurrent();
    if (content) applyContent(content, 'DOM observer');
  });
  activeObserver.observe(container, { childList: true, subtree: true });

  // Primary path: fetch the raw file directly, using whatever ref/path is resolved
  // *right now*. This runs concurrently with the DOM observer above (not after a
  // timeout) since it's normally the faster of the two.
  const fetchTarget = resolved;
  log(navStart, 'raw fetch started');
  fetchRawFileContent(fetchTarget.repoOwner, fetchTarget.repoName, fetchTarget.ref, fetchTarget.filePath).then(async (raw) => {
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
      return;
    }

    // The naive guess wasn't corrected by embedded data (either it's not present, or
    // it agreed with the naive guess) and still failed — this is the actual signature
    // of a slash-containing branch name GitHub's markup didn't help us catch. Fall back
    // to checking the URL segments against the repo's real branch/tag names before
    // giving up and relying on the DOM observer. Only worth trying when there's more
    // than one path segment to disambiguate in the first place.
    if (route.filePath.includes('/')) {
      const knownRefs = await getRefNames(route.repoOwner, route.repoName);
      if (myNavId !== navId) return;

      const corrected = resolveRefFromKnownNames(route, knownRefs);
      if (corrected) {
        log(navStart, `ref corrected via branches/tags API fallback (${route.ref} -> ${corrected.ref})`);
        resolved = corrected;
        const retried = await fetchRawFileContent(
          corrected.repoOwner,
          corrected.repoName,
          corrected.ref,
          corrected.filePath,
        );
        if (myNavId !== navId) return;

        if (retried && isFileContentReady(retried)) {
          applyContent(retried, 'raw fetch (ref corrected via branches/tags API)');
          return;
        }
      }
    }

    log(navStart, 'raw fetch failed or returned no usable content — relying on DOM observer');
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
