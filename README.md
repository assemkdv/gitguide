# GitGuide

GitGuide is a Chrome extension that helps developers understand and contribute to
GitHub repositories. It slides in as a panel on any GitHub repo, issue, or file page
and uses an LLM to generate structured, actionable explanations — without leaving
GitHub or reloading the page.

## Overview

Open a GitHub repository, issue, or file with the extension installed, and the
GitGuide launcher appears bottom-right. Quick Actions generate a structured
explanation of whatever you're looking at (repo, file, or issue); a persistent
per-repository chat lets you ask follow-ups grounded in that context. Navigation
between pages, file/issue detection, and result caching are all automatic — GitGuide
tracks GitHub's client-side routing rather than requiring a page reload.

The project is a small monorepo: a Chrome extension (Manifest V3) as the frontend, and
a local Express + Groq backend that does the actual LLM calls and GitHub API lookups
so the Groq API key never has to live in the browser.

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│   Chrome Extension           │        │   Local Backend           │
│   (apps/extension)           │  HTTP  │   (apps/api)               │
│                               │───────>│                            │
│  content scripts  ─┐         │        │  Express routes:           │
│   (nav detection,  │         │        │   /v1/explain-repo         │
│    keyboard guard) │         │        │   /v1/explain-file(+quick) │
│                     ▼         │        │   /v1/analyze              │
│  panel (React + Zustand) ────┼───────>│   /v1/good-first-issues     │
│   Quick Actions, chat,       │  SSE   │   /v1/chat (streaming)      │
│   result cards                │<──────│                            │
│                               │        │  lib/github.ts ───────────┼──> GitHub REST API
│  background service worker ──┼───────>│  Groq SDK ─────────────────┼──> Groq LLM API
│   (chat SSE proxy)            │        │                            │
└─────────────────────────────┘        └──────────────────────────┘
        runs inside github.com                runs on localhost:3000
```

### Extension architecture (`apps/extension`)

- **`src/content/`** — MAIN-world scripts (`nav-patch.ts`, `keyboard-guard.ts`)
  injected at `document_start`, in the page's own JS context (not the isolated
  content-script world), so they can observe GitHub's own `history.pushState`/
  `replaceState` calls and intercept keyboard events at the same priority as GitHub's
  own shortcut handlers. `nav-patch.ts` re-dispatches a `gitguide:navigation` DOM event
  that the isolated-world panel code listens for. `index.ts` / `mount.tsx` mount the
  panel into a shadow-DOM host at `document_idle`, re-creating it if GitHub's SPA ever
  sweeps it away during a client-side navigation.
- **`src/panel/`** — the panel itself, an isolated-world React app:
  - `store.ts` — a single Zustand store: page context, per-feature results/loading/
    error state, file-detection stage, chat state.
  - `App.tsx` — the panel shell plus GitHub SPA navigation detection (URL-change
    listeners, a targeted `MutationObserver` for issue-content readiness, and the fast
    path described below for files).
  - `file-detection.ts` — the file-content pipeline (see below).
  - `runActions.ts` — the four Quick Action API calls (explain repo/file, summarize
    issue, good-first-issues), each with client-side result caching.
  - `storage.ts` — `chrome.storage.local` caching (TTL + expiry sweep) and per-repo
    chat history persistence.
  - `components/` — UI: Quick Actions home, per-feature result cards, chat, empty/
    error states.
- **`src/background/service-worker.ts`** — proxies the chat SSE stream from the API to
  the panel over a `chrome.runtime.connect` port. This exists because content scripts
  don't have a convenient way to consume a streaming `fetch` response and forward it
  incrementally the way a background script can relay chunks over a port.

#### File-detection pipeline

Opening a file is handled independently of GitHub's own render speed:

1. The file's `owner/repo/ref/path` is parsed directly from the URL — no DOM access —
   the instant navigation is detected (typically well under 100ms after the URL
   changes).
2. A direct fetch to `raw.githubusercontent.com` and a `MutationObserver` scoped to
   the file content container race concurrently; whichever produces content first
   wins, and the other is torn down.
3. Because the URL alone can't tell a multi-segment branch name (`release/v2`) from a
   nested file path, the naive URL guess is corrected against GitHub's own embedded
   page data (a JSON payload GitHub renders into every blob page) wherever that's
   available — validated by reconstructing the blob URL from it and requiring an exact
   match against the address bar, so a stale/unrelated payload can't be mistaken for
   the current file.
4. A monotonic navigation id guards every async callback so a slow/stale request from
   a file the user has since navigated away from can never overwrite current state,
   and a raw-fetch result is discarded (in favor of the DOM-derived content) if the
   ref it was fetched with turns out to have been wrong.

Timing is logged to the console as `[GitGuide] ...` during development
(`import.meta.env.DEV`); these calls are stripped entirely from production builds
(verified by grepping the built bundle for the log strings).

### Backend architecture (`apps/api`)

A small Express server, one route per feature:

| Route                       | Method | Purpose                                             |
| ---------------------------- | ------ | ---------------------------------------------------- |
| `/v1/explain-repo`           | POST   | Repository-wide explanation                          |
| `/v1/explain-file`           | POST   | Detailed single-file explanation                      |
| `/v1/explain-file/quick`     | POST   | Fast, low-detail pass shown while the full one runs   |
| `/v1/analyze`                | POST   | Issue summary/implementation guidance                 |
| `/v1/good-first-issues`      | POST   | Open `good first issue`/`help wanted` search           |
| `/v1/chat`                   | POST   | Streaming (SSE) follow-up chat                        |
| `/health`                    | GET    | Liveness check                                        |

Each non-chat route: validates the request body against a [Zod](https://zod.dev)
schema (`lib/schemas.ts`), fetches whatever GitHub context it needs
(`lib/github.ts`), builds a prompt, calls Groq (`llama-3.3-70b-versatile` for
detailed responses, `llama-3.1-8b-instant` for the quick file pass), and parses the
model's JSON response (`lib/groq-json.ts`, shared across every route so the
markdown-fence-stripping logic can't drift between call sites). `/v1/chat` streams
Server-Sent Events instead of returning a single JSON body.

**Request cancellation**: every route creates an `AbortController` and listens on
`res.on('close', ...)` — Express's `res` (response) `'close'` event, not `req`'s,
which fires as soon as the request body finishes being read rather than when the
client actually disconnects. The resulting signal is threaded through every GitHub
fetch and the Groq call, so if the panel is closed or the user navigates away
mid-request, in-flight work is aborted instead of running to completion for a
response nobody will read. The `/v1/chat` stream additionally checks the signal
before every SSE chunk write and stops pulling tokens from Groq the moment the client
is gone.

Repository metadata (tree, README, issues) is fetched from the unauthenticated GitHub
REST API, optionally using a `GITHUB_TOKEN` for higher rate limits.

## Feature list

- **Explain Repository** — purpose, tech stack, folder structure, architecture, key
  entry points, data flow, how to run, and where a beginner should start.
- **Explain File** — purpose, plain-English summary, main components, inputs/outputs,
  dependencies, how it connects to the rest of the project, important logic, edge
  cases, contributor notes, and related files worth exploring next. A fast low-detail
  pass appears first (small/fast model) while the full explanation keeps generating.
- **Summarize Issue** — what it's asking, why it matters, current vs. expected
  behavior, discussion context, relevant files, implementation steps, risks, testing
  considerations, difficulty, and time estimate.
- **Find Good First Issue** — surfaces open `good first issue`/`help wanted` issues;
  clicking one navigates to it and automatically runs Summarize Issue.
- **Persistent per-repository chat** — ask follow-up questions grounded in whatever
  GitGuide already generated for that repo; history persists across panel open/close
  and GitHub navigation.
- **Automatic detection** — the panel tracks GitHub's client-side (SPA) navigation and
  re-detects the current file/issue/repo without a page reload.
- **Result caching** — repo/file/issue results are cached in `chrome.storage.local`,
  scoped by repository (and, for files, by ref+path so different branches never share
  a stale cache entry), with a TTL and an expiry sweep on panel mount so storage
  doesn't grow unbounded.
- **Request validation** — every backend endpoint validates its input with Zod before
  doing any work, returning a clear 400 with per-field details on malformed requests.
- **Request cancellation** — both the extension (stale-navigation guards) and the
  backend (`AbortController` propagated through every GitHub/Groq call) stop doing
  work for a request nobody's waiting on anymore.

## Installation

### Prerequisites

- Node.js 18+
- A [Groq](https://console.groq.com) API key
- Google Chrome

### 1. Clone and install dependencies

```bash
git clone https://github.com/assemkdv/gitguide.git
cd gitguide
npm install
```

This installs both workspaces (`apps/api`, `apps/extension`) from the repo root.

### 2. Configure environment variables

Copy `.env.example` to `.env` in the repo root and fill in your key:

```bash
cp .env.example .env
```

| Variable       | Required | Default | Description                                                              |
| -------------- | -------- | ------- | -------------------------------------------------------------------------- |
| `GROQ_API_KEY` | Yes      | —       | Groq API key. The API refuses to start without it.                        |
| `PORT`         | No       | `3000`  | Port the local API listens on.                                            |
| `GITHUB_TOKEN` | No       | —       | Optional GitHub PAT for higher-rate-limit repo/README/tree/issue lookups. |

`GITHUB_TOKEN` needs no special scopes for public repositories — a plain
[personal access token](https://github.com/settings/tokens) is enough to raise the
GitHub API rate limit from 60/hour (unauthenticated) to 5,000/hour.

The extension has its own, separate env var, read at build time (not runtime):

| Variable       | Required | Default                 | Description                                                        |
| -------------- | -------- | ------------------------ | -------------------------------------------------------------------- |
| `VITE_API_URL` | No       | `http://localhost:3000` | Base URL the extension calls for all API requests. See `apps/extension/.env.example`; `apps/extension/.env.production` pins production builds to the deployed Render URL. |

## Running the backend

```bash
npm run dev:api
```

Starts the Express server on `http://localhost:3000` with hot reload (`tsx watch`).
Verify it's up:

```bash
curl http://localhost:3000/health
# {"ok":true}
```

This backend is Node/Express + the Groq SDK — not FastAPI/Python — despite that name
sometimes being used loosely for "the local API service." There is no Python runtime
dependency anywhere in the served application.

## Loading the Chrome extension

```bash
npm run build:extension
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select `apps/extension/dist`. Open any GitHub repository and click the GitGuide
launcher (bottom-right).

`npm run build:extension` is a production build, so it talks to the deployed backend
(`https://gitguide-api.onrender.com`, pinned via `apps/extension/.env.production`) —
not your local API. If you want the unpacked extension to hit a locally running
backend instead, run `VITE_API_URL=http://localhost:3000 npm run build --workspace=apps/extension`.

Re-run `npm run build:extension` and click the reload icon on the extension card after
making changes — the extension does not hot-reload itself. `npm run dev` inside
`apps/extension` runs Vite in watch mode, but you still need to reload the unpacked
extension in Chrome to pick up new output.

## Build commands

| Command                                        | Effect                                          |
| ----------------------------------------------- | ------------------------------------------------ |
| `npm run build:extension` (repo root)            | Production extension build → `apps/extension/dist` |
| `npm run build` (inside `apps/api`)              | Compiles the backend → `apps/api/dist`             |
| `npm run dev:api` (repo root) / `npm run dev` (`apps/api`) | Backend with hot reload                |
| `npm run dev` (inside `apps/extension`)          | Vite watch mode (still requires a manual reload in `chrome://extensions`) |

## Testing

```bash
npm run lint    # ESLint across both apps, from repo root
npm test        # vitest — apps/api then apps/extension, from repo root
```

Or per package: `npm run test --workspace=apps/api`,
`npm run test --workspace=apps/extension`. Typecheck a single package with
`npx tsc --noEmit` from inside `apps/api` or `apps/extension` (both run with
`noUnusedLocals`/`noUnusedParameters` enabled).

Test coverage is intentionally scoped to pure/isolatable logic: URL parsing and
ref/path resolution (including the slash-branch disambiguation described above), cache
key scoping, store reducers, stale-navigation cancellation, request validation, and
JSON-completion parsing. See **Known limitations** for what isn't covered.

## Deployment notes

- **Backend**: deployed as a standard Node/Express service on Render at
  `https://gitguide-api.onrender.com`, reading `GROQ_API_KEY`/`PORT`/`GITHUB_TOKEN` from
  environment variables set in the Render dashboard (not a committed `.env`). It's a
  stateless service, so it would run unmodified on any other Node host (Fly.io, a
  container, etc.) too.
- **Extension → backend URL**: the extension reads its API base from
  `import.meta.env.VITE_API_URL` (see `apps/extension/src/config.ts`), falling back to
  `http://localhost:3000` when unset. `apps/extension/.env.production` pins this to the
  Render URL, so `npm run build:extension` (production mode) always targets the
  deployed backend automatically — `npm run dev` (development mode) does not load that
  file, so local dev keeps targeting `localhost:3000`. Override per-build by setting
  `VITE_API_URL` yourself if you deploy to a different host.
- **CORS**: `apps/api/src/server.ts` allows requests with no `Origin` header, any
  `chrome-extension://*` origin, `https://github.com`, and `http://localhost:5173`.
  The `chrome-extension://*` wildcard is intentional and temporary: the final Chrome
  Web Store extension ID isn't known yet (the extension is only distributed unpacked so
  far), and `chrome-extension://` origins can't be forged by ordinary web pages, so
  accepting any extension ID is a reasonable stand-in until the ID is fixed. **Once the
  extension has a permanent Web Store ID, tighten this regex to that exact origin**
  (`chrome-extension://<final-id>`) instead of the current wildcard.
- The extension itself is still only distributed as an unpacked build (`Load unpacked`
  in developer mode) — publishing to the Chrome Web Store would require its own
  review/packaging process not set up here.
- No CI/CD pipeline is configured. `npm run lint`, `npm test`, and the build commands
  above are meant to be run manually (or wired into a CI provider of your choice)
  before shipping a change.

## Performance

Route/context-parsing timing is logged to the console during development (see
*File-detection pipeline* above) so navigation performance is directly observable, not
just estimated.

For LLM response time, below are informal, single-run measurements taken against the
live local API during this pass (Groq `llama-3.3-70b-versatile`/`llama-3.1-8b-instant`,
network conditions of this environment) — real numbers, not estimates, but **not** a
statistically meaningful benchmark (one sample each, no percentiles, no cache-warm vs.
cache-cold split beyond what's noted):

| Operation                                  | Observed (single run) |
| -------------------------------------------- | ---------------------- |
| Explain File — quick pass                    | ~0.5s                  |
| Explain File — full pass                     | ~1.0s                  |
| Summarize Issue                              | ~1.1s                  |
| Explain Repository                           | *(see TODO below)*     |
| Cached result load (`chrome.storage.local`)  | *(see TODO below)*     |

**TODO — proper benchmarking.** These numbers are not reliable enough to plan around;
Explain Repository in particular does several sequential/parallel GitHub API calls
plus per-entrypoint file fetches before the Groq call even starts, so its latency
depends heavily on repo size and wasn't reliably measurable in this pass (one attempt
hit a transient network timeout fetching an entrypoint file). To get real numbers:

1. Add timing instrumentation around each route in `apps/api/src/routes/*.ts`
   (`performance.now()` before/after the GitHub fetch phase and the Groq call,
   logged or exposed via a `X-Response-Time` header).
2. Run each endpoint against a fixed set of representative repos (small/medium/large)
   several times each (e.g. 10 runs, report p50/p90) with a warm Groq connection.
3. For cached-result load time, measure `storage.ts`'s `loadRepoCache`/`loadFileCache`/
   `loadIssueCache` directly (a `chrome.storage.local.get` round-trip) — this should be
   single-digit milliseconds, but wasn't independently measured here; add a unit-style
   timing test similar to the existing `storage.test.ts` if this needs to be tracked
   over time.

## Known limitations

- **No automated Chrome-extension or GitHub SPA end-to-end tests.** The navigation/
  detection logic is covered by unit tests around its pure pieces (URL parsing, ref
  resolution, cache keys, navId cancellation), but there's no Playwright/Puppeteer
  suite driving a real or mocked GitHub page — verifying live SPA navigation
  (repo → file → issue → back, etc.) is currently a manual step.
- **Private repositories are not supported end-to-end.** The backend can use a
  `GITHUB_TOKEN` for its own REST calls, but the extension's direct
  `raw.githubusercontent.com` fetch and the file-content DOM fallback have no
  authentication path, so Explain File will fall back to (unauthenticated) DOM
  extraction on a private repo and may not find content at all if that fails.
- **Slash-branch ref resolution depends on GitHub's page markup.** A branch name
  containing a slash (`feature/auth`, `release/v2`) is now resolved correctly by
  reading GitHub's own embedded page data (see *File-detection pipeline*), but if
  GitHub changes that markup, resolution silently falls back to the naive (and for
  those branches, wrong) URL-only guess rather than erroring loudly.
- **No schema validation on API *outputs*.** Inputs are now validated with Zod, but
  the model's JSON response is only lightly cleaned (markdown-fence stripping) and
  parsed — a malformed completion causes a 500, not a validated/partial response.
- **No LLM-side cancellation for the extension's own stale-request handling.** The
  extension ignores a stale response client-side, and the backend now aborts
  in-flight work when the client disconnects (see *Backend architecture*) — but there
  is still no mechanism for the extension to proactively tell the backend "cancel
  this specific request" other than closing the connection.
- **This project currently has no git history of its own** — it lives inside a parent
  directory that is itself an (uninitialized, commit-less) git repository rooted
  above `GitGuide/`. A `.gitignore` has been added, but nothing has been committed.
  If you want version control scoped to this project, run `git init` inside
  `GitGuide/` (or address the parent repo situation) before your first commit.
