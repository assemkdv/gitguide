# GitGuide

GitGuide is a Chrome extension that helps you understand a GitHub repository without
leaving the page. Open a repo, a file, or an issue, hit a button, and GitGuide gives
you a clear, structured explanation of what you're looking at — powered by an LLM
running on a small backend, not a browser API key.

It's built for anyone who's ever landed on an unfamiliar repo and wanted to know
"okay, but where do I even start?" — new contributors, developers exploring open
source, or anyone triaging an issue they didn't write.

## What it does

- **Explain Repository** — purpose, tech stack, architecture, and where to start reading
- **Explain File** — what a file does, its key pieces, and how it fits into the project
- **Summarize Issue** — what's being asked, which files are relevant, and how to approach it
- **Find Good First Issue** — surfaces open `good first issue` / `help wanted` issues
- **Chat** — ask follow-up questions grounded in whatever GitGuide already explained
- **Just works as you browse** — detects GitHub's page changes automatically, no reload
- **Fast on repeat visits** — results are cached, so re-opening something you already explained is instant
- **Streams responses** — chat answers appear as they're generated, not all at once

## Why it exists

Open source repos are often harder to get into than they should be. Docs go stale,
architecture isn't written down anywhere, and figuring out whether an issue is
actually approachable usually means reading through code and old discussion threads
by hand. GitGuide skips that step — it reads the repo for you and gives you a
grounded starting point, right where you're already working.

## Tech stack

| Layer     | Technologies                                                        |
| --------- | ---------------------------------------------------------------------- |
| Extension | TypeScript, React, Zustand, Vite (`@crxjs/vite-plugin`), Manifest V3   |
| Backend   | Node.js, Express, Groq SDK, Zod                                        |
| Tooling   | npm workspaces, Vitest, ESLint                                         |

## How it's built

GitGuide is a small monorepo: a Chrome extension that lives on the page, and a
lightweight backend that talks to Groq and the GitHub API on its behalf (so your Groq
key never ends up in the browser).

```
Chrome Extension  →  Backend  →  Groq (LLM)
                         ↓
                   GitHub REST API
```

- The **extension** watches for GitHub page changes, renders the panel, and calls the
  backend whenever you trigger an action.
- The **backend** validates the request, pulls whatever GitHub context it needs, and
  asks Groq to generate the explanation.
- **Groq** does the actual reasoning/writing.
- The **GitHub API** supplies repo, file, and issue data.

Curious how the pieces fit together internally? See [How it works under the
hood](#how-it-works-under-the-hood) below.

## Getting started

### You'll need

- Node.js 18+
- A [Groq](https://console.groq.com) API key
- Google Chrome

### 1. Clone and install

```bash
git clone https://github.com/assemkdv/gitguide.git
cd gitguide
npm install
```

This installs both workspaces (`apps/api`, `apps/extension`) from the repo root.

### 2. Set up your environment

```bash
cp .env.example .env
```

| Variable       | Required | Default | What it's for                                                    |
| -------------- | -------- | ------- | -------------------------------------------------------------------- |
| `GROQ_API_KEY` | Yes      | —       | The API won't start without it.                                       |
| `PORT`         | No       | `3000`  | Port the local API listens on.                                        |
| `GITHUB_TOKEN` | No       | —       | Optional PAT, bumps GitHub's rate limit from 60/hr to 5,000/hr. No special scopes needed for public repos. |

### 3. Start the backend

```bash
npm run dev:api
```

Runs on `http://localhost:3000` with hot reload. Sanity check:
`curl http://localhost:3000/health` → `{"ok":true}`.

(It's a plain Node/Express server, in case the "backend" naming ever gets confused
with something Python-flavored — no Python involved anywhere here.)

### 4. Load the extension

```bash
npm run build:extension
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** →
select `apps/extension/dist`. Open any GitHub repo and you'll see the GitGuide
launcher bottom-right.

This build points at the deployed backend by default — see [Deployment](#deployment)
if you want it hitting your local server instead. There's no hot reload for the
extension itself, so rebuild and hit the reload icon on the extension card after
making changes.

## Testing

```bash
npm run lint    # ESLint across both apps
npm test        # vitest — apps/api then apps/extension
```

Tests focus on the logic that's actually worth unit testing — URL/ref parsing, cache
scoping, store behavior, stale-request cancellation, request validation, and response
parsing. What's *not* covered is called out in [Known limitations](#known-limitations).

---

## How it works under the hood

A closer look at how the two apps are structured and a few of the trickier problems
GitGuide had to solve along the way.

```
┌─────────────────────────────┐        ┌──────────────────────────┐
│   Chrome Extension           │        │   Backend                 │
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
```

### The extension

The panel is a React app that mounts into a shadow DOM on every GitHub page, so its
styles never leak into GitHub's own UI. A couple of small scripts run in the page's
own JS context (not the usual sandboxed content-script world) so they can catch
GitHub's client-side navigation as it happens and hook keyboard shortcuts at the same
priority as GitHub's own. That's what lets GitGuide react to you clicking around
GitHub without ever doing a full page reload.

Chat is the one exception that needs a background service worker: streaming a
response chunk-by-chunk from a content script isn't straightforward in Chrome, so the
service worker proxies the SSE stream over to the panel.

**Opening a file** is the fussiest part of the extension. GitGuide doesn't wait for
GitHub to finish rendering — it parses the file path straight from the URL and kicks
off a raw content fetch immediately, racing it against a DOM observer as a fallback.
The one wrinkle: a branch name like `release/v2` looks identical to a nested file path
from the URL alone, so GitGuide double-checks itself against a small JSON payload
GitHub already embeds in the page, and corrects course if the fast guess was wrong.

If you navigate away before any of this finishes, GitGuide throws the in-flight work
away instead of letting it clobber whatever you're now looking at.

### The backend

One Express route per feature (`/v1/explain-repo`, `/v1/explain-file`, `/v1/analyze`,
`/v1/good-first-issues`, `/v1/chat`), each doing the same basic thing: validate the
request with [Zod](https://zod.dev), fetch whatever GitHub context it needs, build a
prompt, and call Groq. `/v1/chat` is the only one that streams its response back over
SSE instead of returning a single JSON blob.

A few things worth calling out:

- **Bad requests get rejected immediately.** Every route validates its input before
  doing any work, so a malformed request comes back as a clean `400` instead of a
  confusing failure three steps later.
- **Cancelled requests actually stop.** If you close the panel or navigate away before
  a response finishes, the backend notices the connection dropped and cancels the
  in-flight GitHub/Groq calls instead of burning tokens on a response nobody will see.
- **Results are cached client-side.** Repo/file/issue explanations are stored in
  `chrome.storage.local`, scoped so different branches or files never share a stale
  cache entry, with a TTL so old entries clean themselves up.

## Deployment

The backend is deployed as a plain Node/Express service on Render, at
`https://gitguide-api.onrender.com` — nothing fancy, just environment variables set
in the Render dashboard and a stateless app that would run the same way on Fly.io or
anywhere else.

The extension picks up its API URL at build time via `VITE_API_URL`, falling back to
`http://localhost:3000` if it's not set. Production builds (`npm run build:extension`)
are pinned to the Render URL through `apps/extension/.env.production`; local dev
builds are untouched and keep talking to `localhost:3000`. To point an unpacked build
at your own backend: `VITE_API_URL=http://localhost:3000 npm run build --workspace=apps/extension`.

On the backend side, CORS is currently open to any `chrome-extension://` origin, since
the extension isn't published to the Chrome Web Store yet and doesn't have a
permanent ID. That's safe in practice (that scheme can't be spoofed by a regular
website), but once GitGuide has a real Web Store ID, that should be locked down to
the exact extension ID in `apps/api/src/server.ts`.

There's no CI/CD set up — `npm run lint`, `npm test`, and the build commands below are
run by hand for now.

| Command                                                    | What it does                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `npm run build:extension` (repo root)                        | Production extension build → `apps/extension/dist`         |
| `npm run build` (inside `apps/api`)                          | Compiles the backend → `apps/api/dist`                     |
| `npm run dev:api` (repo root) / `npm run dev` (`apps/api`)   | Backend with hot reload                                    |
| `npm run dev` (inside `apps/extension`)                      | Vite watch mode (still needs a manual reload in Chrome)    |

## Performance

Below are informal, single-run timings against the live API — real numbers, but one
sample each, so treat them as a rough feel rather than a benchmark:

| Operation                                  | Observed (single run) |
| -------------------------------------------- | ---------------------- |
| Explain File — quick pass                    | ~0.5s                  |
| Explain File — full pass                     | ~1.0s                  |
| Summarize Issue                              | ~1.1s                  |
| Explain Repository                           | *(see TODO below)*     |
| Cached result load (`chrome.storage.local`)  | *(see TODO below)*     |

**TODO — proper benchmarking.** Explain Repository does several GitHub API calls plus
per-file fetches before Groq is even involved, so its latency swings a lot with repo
size — it wasn't reliably measurable yet (one attempt hit a transient network
timeout). To get real numbers: add timing around the GitHub-fetch and Groq-call phases
in each route, run a fixed set of small/medium/large repos several times each and
report p50/p90, and measure `storage.ts`'s cache reads directly (should be single-digit
milliseconds, but hasn't been confirmed).

## Known limitations

- **No end-to-end tests.** Unit tests cover the pure logic (URL parsing, ref
  resolution, cache keys, cancellation), but there's no Playwright/Puppeteer suite
  driving an actual GitHub page — SPA navigation is verified manually for now.
- **Private repos aren't fully supported.** The backend can use a `GITHUB_TOKEN` for
  its own calls, but the extension's raw-content fetch and DOM fallback have no auth
  path, so Explain File may come up empty on a private repo.
- **Slash-branch detection depends on GitHub's page markup staying the same.** It
  works today by reading a JSON payload GitHub embeds on file pages; if GitHub changes
  that markup, it'll quietly fall back to a naive (and for slash-branches, wrong)
  guess instead of erroring loudly.
- **API responses aren't schema-validated.** Requests are; a malformed model response
  currently just fails with a 500 rather than degrading gracefully.
- **Cancellation is connection-based, not explicit.** The backend stops working when
  the client disconnects, but there's no dedicated "cancel this request" signal from
  the extension — closing the connection is the only way to cancel right now.
