# GitGuide release-candidate audit (2026-10-07)

Scope: the `main` checkout at `9779a7e`, taken to a Chrome Web Store release candidate.
"Confirmed" means reproduced by a failing test, a live call, or a real-browser run (the
evidence column says which); "suspected" means plausible, but not verifiable from here.
Line references for original defects point at `9779a7e`.

## Baseline (before changes)

`npm ci`, `npm run lint`, API build, extension `tsc`, `npm test` (API 195, extension 64),
and `npm run build:extension` all passed. `npm audit --omit=dev` reported 0
vulnerabilities at the time; after `npm audit fix` later in the session, see §5.

## 1. Confirmed defects, by priority

### P0: release blockers

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | **Every AI request fails**: the hard-coded models `llama-3.3-70b-versatile` / `llama-3.1-8b-instant` return `404 model_not_found` for the key in `.env`. | Live call through the local API; Groq `/models` list for the key shows neither model. Whether production uses the same key is unknown (§2). | Defaults switched to `openai/gpt-oss-120b` / `-20b` (env-overridable, reasoning budget added); startup `model_check` log line plus `/ready` report a missing model; provider status/error type are now logged. `lib/ai-models.ts`, `lib/config.ts` |
| 2 | **Private-repository content was sent to the server and Groq.** The extension posted DOM-extracted file text (`fileContent`) and issue body/comments for any page, including private repositories (the raw fetch fails for private repos, so it fell back to the DOM). | `runActions.ts:90-108,154-165`; `file-detection.ts` DOM fallback | Requests carry identifiers only (schemas strip content fields; test proves it); the server reads public content itself; client-side private detection sends nothing; server refuses non-public repos. |
| 3 | **A configured `GITHUB_TOKEN` could expose private repositories** it can read: `getRepoInfo` never checked `private`/`visibility`. | `github.ts:20-30` | `getRepoInfo` throws `PRIVATE_REPO_UNSUPPORTED` unless the repository is public; tests cover private/internal. |
| 4 | **Enter-to-send and Escape never worked in Chrome.** The MAIN-world keyboard guard called `stopImmediatePropagation()` in window capture, so the panel never received keydown (Enter inserted a newline). jsdom tests couldn't see it. | Playwright run of the original build: 0 requests sent, textarea `"via enter\n"` | Guard forwards a non-composed copy into the shadow root and prevents the original's default only if the panel handled it (`content/keyboard-guard.ts`); browser tests cover Enter, Escape, and GitHub-shortcut isolation. |

### P1: correctness and reliability

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 5 | **Navigation races in Quick Actions**: late errors landed on the new page; an old request's `finally` cleared the new request's loading flag; the quick file explanation checked only `filePath` (so it crossed repos/refs); cache hits weren't target-checked; duplicate requests; obsolete requests weren't cancelled. | 5 tests run against the original `runActions.ts` in a worktree: all 5 failed | `runActions.ts` rewritten around complete target identity and request ownership (cache read, success, failure, cleanup); obsolete requests aborted on navigation; same-target requests deduplicated. 21 regression tests plus browser tests. |
| 6 | **Tags and SHAs failed** in Ask GitGuide: `getBranchHeadSha` resolved only `refs/heads/*`. The README ignored the ref; index content was fetched by mutable branch while the cache key used a SHA (mixed snapshots if the branch moved); citation URLs used the mutable ref and unencoded paths. | `github.ts:36-46,48,104-116`; `ask-repo.ts:66`; live: `/commits/{ref}` peels annotated tags (`git/git v2.0.0` → commit `e156455`, while the tag object is `18a0735`) | `resolveSnapshot` → immutable commit (branches, lightweight/annotated tags, short/full SHAs, slash branches); tree/README/files read at that commit; citations pinned to the commit with encoded paths. Live-verified on a tag and on `microsoft/vscode@release/1.80`. |
| 7 | **Background indexing could stay "background-indexing" forever**, and cached entries never resumed it. | `indexer.ts:205-232` (no state update on failure), `:253-254` | Lifecycle partial → background-indexing → complete/failed in try/finally; failed jobs resume on a later question with a cooldown, up to 3 attempts; tests cover all of it. |
| 8 | **The first requester's disconnect cancelled shared indexing for everyone** (Phase A used that request's signal). | `indexer.ts:259` | `SharedJob`: each subscriber leaves independently; the job aborts only when all have gone. |
| 9 | **Evicted entries repopulated the cache**: the background loop called `store.set` on an evicted entry, pushing out entries in active use. | `indexer.ts:224` | Eviction aborts that entry's job; background work never refreshes recency; a stale job stops if its entry isn't the cached one. |
| 10 | **GitHub failures became "successful" empty results**: rate limits or outages made the tree `[]`, README `''`, file `''`, and good-first-issues `[]` ("No issues found"). | `github.ts:50,62,87,115` | Structured errors (`GITHUB_RATE_LIMITED` with retry time, `REPO/REF/FILE/ISSUE_NOT_FOUND`, `UPSTREAM_TIMEOUT`, …); one retry only for network/5xx; explain-repo marks good-first-issues as *unavailable* rather than empty. |
| 11 | **Unbounded resources**: no global AI concurrency or spend cap, no file-size or index budget, no upstream timeouts (Groq default 60 s × 3 tries), no graceful shutdown. | code inspection | Global AI semaphore + daily budget (`ai-guard.ts`); concurrent index-job limits; 100 KB/file (skipped from tree size, never downloaded), 3 MB / 3,000 chunks per repo; GitHub 10 s and Groq 60 s deadlines, one Groq retry; SIGTERM drain. |
| 12 | **Incomplete streams looked complete**: the service worker sent a synthetic `done` at EOF, skipped malformed events silently, and didn't support multi-line `data:` or a final event without a trailing blank line. A connection dropped mid-answer was reported as "server unreachable". | `service-worker.ts:65,70` (original); browser test | Spec-compliant incremental parser (`background/sse.ts`); only an explicit `done` completes; EOF → `STREAM_INTERRUPTED`; malformed → `MALFORMED_STREAM`; 60 s idle timeout; tests split input at every position. |
| 13 | **Chat races**: a late history load replaced a newly started conversation; while fixing it, a test showed that the first save could also *overwrite stored history* if sent before loading finished. Updates went to "the last message" of whatever conversation was current. | `AskGitGuidePage.tsx:39-47` (original); `chat.test.ts` | `chat.ts`: per-conversation, per-message-id updates; hydration merges; persistence waits for hydration. |
| 14 | **Local development broken on current Chrome**: content-script `fetch` to `http://localhost` from github.com is blocked by Local Network Access. | Playwright: every Quick Action failed against a localhost API; chat (service worker) worked | All API calls go through the service worker (`background/api-relay.ts`); the API now accepts only the extension origin, not `https://github.com`. |
| 15 | **Grounding**: prompts forced fabrication ("exactly 4 entrypoints", "EXACTLY 3", "give your best concrete read rather than hedging", "give the most likely convention"); repository/issue text was not delimited as untrusted; a reply like `{}` became an all-empty "successful" result. | `repo-summary.ts:76-82`, `explain-file.ts:153-158`, `analyze.ts:52-81`, `output-schemas.ts` | Untrusted-data blocks with delimiter neutralisation; "say what's missing" rules; no forced counts; required fields per response; model-named paths verified against the tree and labeled exists/suggestion; issue analysis gets real candidate paths; truncation and coverage reported. |
| 16 | **Errors**: every failure showed "Could not reach the GitGuide API"; CORS rejections returned HTTP 500 with an HTML stack trace outside production; raw error objects (which can include upstream bodies) were logged. | `runActions.ts:15,45`; `server.ts:46,65` | `{error, code, retryAfterSec}` everywhere; specific UI messages with wait times; Retry hidden where pointless; JSON 400/403/404/413/500 handlers; logs carry codes only. |
| 17 | **Corrupted saved panel width → `NaN` width** (`Math.max(320, NaN)`); the width also lived in github.com's own `localStorage`. | Node evaluation of the original expression | Sanitized, viewport-clamped width in `chrome.storage`; legacy key migrated and removed; overlay mode under 760 px; browser test. |
| 18 | **Chat history keyed by repository only**, contradicting the README's claim that a branch switch resets it; error text was appended into answers and later sent back to the model as history. | `AskGitGuidePage.tsx:111`; README | Answers record ref/commit; a notice appears when the viewed ref differs; failed/stopped/interrupted answers are excluded from history. |
| 19 | **Node requirement wrong**: README said Node 18+, but eslint 10 / jsdom 29 need ≥20.19/22.13; CI pinned Node 20 (end of life April 2026). | dependency `engines` fields | `engines >=22.13.0`, `.nvmrc` 22, CI matrix 22/24, Render `NODE_VERSION=22`. |
| 20 | **Manifest**: hard-coded API host permission (could drift from the build's URL); unused `github.com`/`raw.githubusercontent.com` host permissions; release builds weren't checked for localhost. | `manifest.json`, `vite.config.ts` | Permission derived from `VITE_API_URL`; release build rejects non-https/localhost; packaging script verifies the bundle; `minimum_chrome_version` 116. |
| 21 | **Cached file explanations were saved under the previous file's content fingerprint** after in-page navigation: file detection read the code viewer immediately, before GitHub repainted, so `b.ts`'s answer was stored with `auth.ts`'s fingerprint. Later visits then hit or missed the cache depending on render timing, causing duplicate requests (and a matching stale fingerprint could hide a real content change). Found by a CI-only browser-test failure (PR #1, run 37705626766: 3 explain-file requests instead of 2). | Instrumented local run: stored fingerprint for `b.ts` = `1i-7161473e` (auth.ts's), expected `1f-dd7a0563`; new unit tests and the strengthened browser test fail on the original code (3/3) | `file-detection.ts` rejects DOM content that is still the previous page (what was on screen at navigation time, or the previous file's content) and waits for the repaint or the raw fetch; fresh page loads still use the rendered DOM. The browser test now reloads the page and requires a cache hit, which fails deterministically without the fix. |

### P2: usability

- No Stop button, no Retry, no visible interrupted state; answers rendered as raw text →
  Stop/Retry/status notes; Markdown via bundled `react-markdown` (no raw HTML, http(s)
  links only, no remote images, copy buttons on code).
- No way to refresh a cached explanation or to notice changed content → Refresh button;
  cache entries carry a local content fingerprint and are ignored when content changed.
- No data disclosure or clear-data control → a short, non-blocking note under Quick
  Actions and a Privacy & data screen with the clear control. (The first version used a
  blocking first-use notice; it was replaced during review so actions run immediately.)
- Panel copy: no generic AI disclaimer in the footer (citations, coverage notes, and
  specific errors carry that information); no em dashes in UI text, and every AI prompt
  asks the model not to use them (`OUTPUT_STYLE_RULES` in `lib/prompt-safety.ts`).
- Accessibility: ARIA roles/labels on the panel, live regions, focus moves into the panel
  and back to the launcher, keyboard resize handle, reduced-motion support.

## 2. Suspected / not verifiable from here

| Item | Why it matters | What was done | Manual check |
|---|---|---|---|
| Production uses the retired models | AI features may be down in production now | Startup check + `/ready` will show it after deploy | Check Render logs/`/ready` after deploying. |
| Render proxy hop count | Wrong `trust proxy` → shared rate-limit bucket, or spoofable IPs; community reports vary (1–3) | `TRUST_PROXY_HOPS` env; per-request `xff` count logged (no IPs) | `docs/DEPLOYMENT.md` §4 |
| Provider/host retention | Privacy policy accuracy | Marked **[VERIFY]** in `docs/PRIVACY.md` | Operator to confirm Groq and Render terms. |
| Cache fingerprint source on real GitHub | A file's fingerprint comes from either the raw file or the rendered code viewer, whichever arrives first; if GitHub's rendered text differs from the raw file (e.g. whitespace between lines), revisits can miss the cache and re-request. Correctness is unaffected (requests carry identifiers only) | Not changed; fixture pages render identical text, so it can't be verified here | During the smoke test, revisit an explained file after a full reload and check that no new request appears (DevTools → service worker network). |
| GitHub DOM selectors | File/issue readiness depends on GitHub markup that can change | Unchanged; server-side reading makes content accuracy independent of the DOM | Smoke test on real GitHub each release. |
| In-memory limits | Budgets/counters reset on restart; per instance | Documented | Keep a single instance, or move state to a shared store. |

## 3. Tests executed

| Suite | Result |
|---|---|
| `npm ci`, `npm run lint`, API build, extension `tsc`, `npm run build:extension` | pass |
| API unit/integration (Vitest) | **294 passed** (22 files) |
| Extension unit/integration (Vitest) | **136 passed** (12 files) |
| Browser: built MV3 extension in Playwright Chromium 156 (fixture GitHub + mock API) | **13 passed**, 2 consecutive clean runs. CI on PR #1 then failed one test intermittently (defect 21); after the fix, that test passed 5 consecutive repeated runs locally and fails 3/3 on the original code |
| Release packaging checks (`scripts/package-extension.mjs`) | pass; ZIP checksum identical across rebuilds |
| Original-code reproductions (worktree of `9779a7e`) | 5 navigation races, Enter-to-send, NaN width, EOF-as-done: all reproduced |
| Retrieval eval (keyword-only, 16 questions on this repo) | before: hit@1 9, hit@3 12, hit@8 13; after tokenizer change: 9 / 12 / **15** |

**Live smoke tests** (separate from the above; local API built from this branch, real
GitHub unauthenticated, real Groq with the `.env` key, 2026-10-07):

- explain-repo `octocat/Hello-World`: 200; tiny repository → empty entrypoints and run
  steps instead of invented ones.
- explain-file `sindresorhus/slugify@v2.2.1:index.js` (tag) → commit `d572cba`; the
  relative import was resolved and marked verified; quick pass 200.
- analyze `sindresorhus/slugify#1`: 200; suggested file verified.
- ask-repo at tag `v2.2.1`: status → citations (commit-pinned URLs) → 635 chunks → `done`;
  partial coverage reported (6 of 15 files) while background indexing continued.
- explain-repo `microsoft/vscode@release/1.80` (slash branch, 6,419 files): resolved to
  `2ccd690`; "300 of 6,419 file paths" reported.
- Missing ref / repo / file → 404 `REF_NOT_FOUND` / `REPO_NOT_FOUND` / `FILE_NOT_FOUND`.
- Server logs contained no repository names, questions, or content.

**Not run:** the deployed production API (not modified, not deployed); the Chrome Web
Store review; Chrome stable/beta (tests used Playwright's Chromium 156); private
repositories on real GitHub (no test account; covered by fixtures, unit tests, and the
server check); a GitHub-token-authenticated run.

## 4. What changed and why (for maintenance)

**API (`apps/api`)**
- `lib/config.ts`: every env setting parsed and validated once; startup warnings.
- `lib/errors.ts`: `ApiError` + `toApiError` map GitHub/Groq/timeouts to stable codes;
  `sendError` logs codes only.
- `lib/github.ts`: one fetch wrapper (deadline, one retry for network/5xx, rate-limit
  parsing); `resolveSnapshot` → commit SHA; `getTree`/`getReadme`/`getFileAtCommit`
  read at that commit (size-capped, binary-rejecting); `getIssue` reads the issue and up
  to 12 comments; small TTL caches save GitHub quota.
- `lib/indexer.ts`: per-commit index with the lifecycle, limits, `SharedJob`, eviction
  policy, and coverage counters described above; `hasFullCoverage` is the only place
  "full" is decided.
- `lib/ai-guard.ts`: global AI concurrency semaphore and daily budget (`withAiSlot`).
- `lib/prompt-safety.ts`, `lib/path-evidence.ts`: untrusted-data wrapping; path
  verification and commit-pinned blob URLs.
- `lib/bm25.ts`, `lib/retrieval.ts`: camelCase sub-words, light stemming, file path in
  the indexed text.
- Routes take identifiers only and return `meta` (ref, commit, truncation/coverage).
  `/ready` adds readiness; request logs are content-free; SIGTERM drains.

**Extension (`apps/extension`)**
- `panel/runActions.ts`: request ownership (read the header comment first).
- `panel/chat.ts`: all chat behaviour (hydration, streaming, Stop, Retry, persistence).
- `background/api-relay.ts` + `service-worker.ts`: every API call goes through the
  worker; `background/sse.ts` is the stream parser.
- `panel/api-client.ts`: `postJson` over the relay; `toUiError` turns codes into user text.
- `panel/validate.ts`: runtime validation of API responses, stream events, and storage.
- `panel/storage.ts`: versioned keys, fingerprints, quota-tolerant writes, clear-all,
  settings, width sanitizing.
- `content/keyboard-guard.ts`: isolates panel keystrokes from GitHub without breaking
  the panel's own keys.
- UI: Quick Actions data note and Privacy & data screen (`DataNotice.tsx`), Markdown renderer,
  provenance/coverage notes, Refresh, verified-path tags, accessibility.

**Build, release, CI**
- `vite.config.ts`: release vs development mode; permission derived from the API URL.
- `scripts/package-extension.mjs`: verification + deterministic ZIP.
- CI: Node 22/24, packaging check + artifact, Playwright job. `render.yaml` Blueprint.

## 5. Remaining blockers and manual steps

1. **Deploy the API from this branch** (the extension's request format changed), then
   confirm `/ready` → `models.check.status: "ok"`. Verify `TRUST_PROXY_HOPS`
   (DEPLOYMENT.md §4). Set `GITHUB_TOKEN` (no-permission fine-grained token).
2. **Privacy policy**: fill the **[VERIFY]** items (operator, contact, Groq and Render
   retention, token scope) and publish it at a public URL; make sure
   `VITE_PRIVACY_POLICY_URL` points there (the default GitHub link works only if the
   repository is public).
3. **Web Store**: register the developer account, upload `release/…zip`, complete the
   listing and privacy tab from `docs/CHROME_WEB_STORE.md` (re-check the data-category
   answers marked **[VERIFY]** against the dashboard wording), then set
   `ALLOWED_EXTENSION_IDS` on Render to the item id.
4. **Smoke test** the uploaded build with `docs/SMOKE_TEST.md` on Chrome stable.
5. **Dependencies**: `npm audit` still reports advisories in `sharp` and `sprintf-js`
   (only via the optional `@huggingface/transformers`, which is never imported when
   embeddings are off, as in production) and in Vite's bundled `esbuild` (dev server
   only). Fixing them needs major upgrades (`@huggingface/transformers`, Vite 6+); worth
   scheduling, not a blocker for this release.
6. **Bundle size**: `react-markdown` adds about 48 KB gzipped to the content script
   (63 → 111 KB), which loads on GitHub pages. Acceptable for now; a lazy-loaded chat
   chunk would remove it from first load.
7. **Version**: `manifest.json` is still `1.0.0` (never published, so valid for a first
   upload); bump it for every later submission.

Nothing was committed, pushed, deployed, purchased, or submitted.
