# GitGuide

GitGuide is a Chrome extension I built to make exploring unfamiliar GitHub repos way
less painful. Instead of jumping between the README, the file tree, and a dozen open
tabs trying to figure out how a project fits together, GitGuide explains it to you
right inside GitHub. Click a button and get a clear breakdown of the repo, the file
you're looking at, or the issue you're trying to understand.

I built this because I kept landing on cool open source repos, wanting to contribute,
and having no idea where to start reading. The docs are usually out of date or just
missing. Figuring out if an issue is actually beginner friendly means reading through
code and comment threads by hand. GitGuide does that legwork for you.

## What it does

- **Explain Repository**: what it is, the tech stack, how it's structured, and where to start reading
- **Explain File**: what a file does and how it connects to the rest of the project
- **Summarize Issue**: what's actually being asked and how you'd approach fixing it
- **Find Good First Issue**: surfaces open `good first issue` / `help wanted` issues
- **Chat**: ask follow-up questions, grounded in whatever GitGuide already explained
- **Detects GitHub navigation automatically**: GitHub doesn't reload the page when you click around, so GitGuide watches for those changes itself and keeps up
- **Caches everything**: open a file or repo you already explained again and it loads instantly
- **Streams chat responses**: answers show up as they're generated, not all at once

## Tech stack

| Layer     | Technologies                                                        |
| --------- | ---------------------------------------------------------------------- |
| Extension | TypeScript, React, Zustand, Vite (`@crxjs/vite-plugin`), Manifest V3   |
| Backend   | Node.js, Express, Groq SDK, Zod                                        |
| Tooling   | npm workspaces, Vitest, ESLint                                         |

## How it's put together

It's a small monorepo. The extension lives on the page, and a lightweight backend
talks to Groq and the GitHub API. I didn't want a Groq API key sitting in the browser
where anyone could pull it out of the extension bundle, so all the AI calls happen
server side.

```
Chrome Extension  →  Backend  →  Groq (LLM)
                         ↓
                   GitHub REST API
```

- The **extension** watches GitHub for page changes, renders the panel, and calls the backend when you hit an action.
- The **backend** checks the request, pulls whatever context it needs from GitHub, and asks Groq to explain it.
- **Groq** does the actual thinking.
- The **GitHub API** supplies the repo, file, and issue data behind all of it.

Want more detail? The section below, [The hard parts](#the-hard-parts), covers how
file detection races the DOM, how request cancellation works, and how I handled
branch names with slashes in them.

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
| `GROQ_API_KEY` | Yes      | none    | The API won't start without it.                                       |
| `PORT`         | No       | `3000`  | Port the local API listens on.                                        |
| `GITHUB_TOKEN` | No       | none    | Bumps GitHub's rate limit from 60/hr to 5,000/hr. Public-repo access only, no special scopes needed. |

### 3. Start the backend

```bash
npm run dev:api
```

Runs on `http://localhost:3000` with hot reload. Quick check it's alive:
`curl http://localhost:3000/health` → `{"ok":true}`.

It's a Node and Express server, not Python. I know "backend" sometimes gets read as
FastAPI, but there's no Python anywhere in this project.

### 4. Load the extension

```bash
npm run build:extension
```

Then in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** →
select `apps/extension/dist`. Open any GitHub repo and the GitGuide launcher shows up
in the bottom-right corner.

This build points at my deployed backend by default. Check the
[Deployment](#deployment) section if you want it pointed at your own local server
instead. The extension doesn't hot-reload, so after making changes you'll need to
rebuild and click the reload icon on the extension card in Chrome.

## Testing

```bash
npm run lint    # ESLint across both apps
npm test        # vitest, runs apps/api then apps/extension
```

I focused testing on the logic that actually needed it: URL and ref parsing, cache
scoping, store behavior, request cancellation, validation, response parsing. I'm not
going to pretend everything's covered. What's missing is listed in
[Known limitations](#known-limitations).

---

## The hard parts

A few problems here looked simple at first and turned out not to be. This is the part
I'm actually proud of.

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

### Getting the extension to feel native to GitHub

The panel renders inside a shadow DOM, so none of my CSS fights with GitHub's. The
harder part was navigation. GitHub is a single-page app, so clicking between files
never triggers a real page load, and GitHub doesn't tell you when that happens
either. So I patch `history.pushState` myself, running that code in the page's own JS
context instead of the sandboxed one Chrome normally gives extensions. That way I
catch every navigation the second it happens and re-render the panel without anyone
reloading anything.

Chat needed a different workaround. Content scripts can't cleanly consume a streaming
fetch response and forward it piece by piece, so chat goes through a background
service worker instead, which proxies the stream back to the panel over a port.

### The one that took the longest: opening a file

I didn't want GitGuide sitting around waiting for GitHub to finish rendering the code
viewer. So it grabs the file path straight from the URL and fires off a raw content
fetch immediately. If that fails, a DOM observer catches it as backup.

Here's the catch. A branch called `release/v2` looks exactly like a nested file path
if you're only looking at the URL. Take `/blob/release/v2/CHANGELOG.md`. Is the ref
`release` and the path `v2/CHANGELOG.md`? Or is the ref `release/v2` and the path just
`CHANGELOG.md`? You genuinely can't tell from the URL alone.

I ended up solving it two ways. GitHub actually embeds the real ref and path as JSON
right in the page, so I read that whenever it's there. If it's missing, maybe GitHub
changed the markup, maybe the page just hasn't finished rendering yet, I fall back to
checking the URL against the repo's real branch and tag names through GitHub's API.
Between the two, slash branches resolve correctly almost every time.

And if you navigate away before any of this finishes, the old request just gets
dropped. I track navigations with an incrementing ID, so a slow response from a page
you already left can never overwrite what you're looking at now.

### The backend

One Express route per feature, and they all follow the same shape. Validate the
request with [Zod](https://zod.dev), pull whatever GitHub context is needed, build a
prompt, call Groq. `/v1/chat` is the odd one out. It streams over SSE instead of
returning one JSON blob.

A few parts of the backend I spent real time getting right:

- **Bad input fails fast.** Every route checks the request before doing any real work. A malformed request gets a clean `400` back immediately instead of failing halfway through an expensive Groq call.
- **Cancelled requests actually stop.** If you close the panel or navigate away mid-request, the backend notices the connection dropped and cancels whatever GitHub or Groq calls were still running. No point burning tokens on a response nobody will see.
- **A bad model response degrades instead of crashing.** Every field in a Groq response gets checked against a schema. If one field comes back wrong, it falls back to a safe default instead of failing the whole request. Only a completely broken response returns an error.
- **Results get cached on the extension side**, scoped so a different branch or file never accidentally reuses someone else's cached explanation.

## Deployment

The backend runs on Render at `https://gitguide-api.onrender.com`. It's a plain Node
and Express service reading its config from environment variables, so it would run
the same way on Fly.io or anywhere else.

The extension picks up its API URL at build time (`VITE_API_URL`), defaulting to
`http://localhost:3000`. Production builds are pinned to the Render URL
automatically. Local dev keeps talking to `localhost:3000` unless you override it:
`VITE_API_URL=http://localhost:3000 npm run build --workspace=apps/extension`.

CORS accepts any `chrome-extension://` origin right now, because I haven't published
to the Chrome Web Store yet and don't have a permanent extension ID to lock it down
to. A regular website can't fake that origin, so it's a reasonable stopgap for now.
Once GitGuide has a real Web Store ID, I want to restrict `apps/api/src/server.ts` to
that exact ID.

There's no CI/CD yet. I run lint, tests, and builds by hand before shipping anything.

| Command                                                    | What it does                                            |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| `npm run build:extension` (repo root)                        | Production extension build → `apps/extension/dist`         |
| `npm run build` (inside `apps/api`)                          | Compiles the backend → `apps/api/dist`                     |
| `npm run dev:api` (repo root) / `npm run dev` (`apps/api`)   | Backend with hot reload                                    |
| `npm run dev` (inside `apps/extension`)                      | Vite watch mode (still needs a manual reload in Chrome)    |

## Performance

These are informal, single-run timings against the live API. Real numbers, but one
sample each, so treat them as a rough feel rather than an actual benchmark:

| Operation                                  | Observed (single run) |
| -------------------------------------------- | ---------------------- |
| Explain File (quick pass)                    | ~0.5s                  |
| Explain File (full pass)                     | ~1.0s                  |
| Summarize Issue                              | ~1.1s                  |
| Explain Repository                           | *(see TODO below)*     |
| Cached result load (`chrome.storage.local`)  | *(see TODO below)*     |

**TODO: proper benchmarking.** Explain Repository does several GitHub calls plus
per-file fetches before Groq is even involved, so its latency depends a lot on repo
size. I haven't measured it reliably yet, one attempt hit a transient network timeout
mid-run. To do this properly, I'd add timing around the GitHub-fetch and Groq-call
phases in each route, run a fixed set of small, medium, and large repos a few times
each, and report p50 and p90. I'd also want to measure the cache reads in
`storage.ts` directly. They should be single-digit milliseconds, but I haven't
confirmed that.

## Known limitations

This isn't finished, and here's what's still missing:

- **No end-to-end tests.** Unit tests cover the pure logic: URL parsing, ref resolution, cache keys, cancellation. There's no Playwright suite driving a real GitHub page yet. I've been checking SPA navigation by hand.
- **Private repos aren't fully supported.** The backend can use a `GITHUB_TOKEN` for its own GitHub calls, but the extension's file-content fetch has no way to authenticate. Explain File can come up empty on a private repo.
- **Slash-branch detection isn't a guarantee.** Two fallback layers cover it well today, but they're both heuristics working around a URL that's genuinely ambiguous. GitHub doesn't promise this will always resolve correctly.
- **A malformed model response still means an incomplete one.** Missing or bad fields get filled in with safe defaults, but if Groq returns something that isn't valid JSON at all, that's still an error instead of a recovered response.
- **Cancellation only happens when the connection drops.** There's no explicit "cancel this request" signal yet. Closing the connection is the only way to cancel one for now.
