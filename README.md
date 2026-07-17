# GitGuide

[![CI](https://github.com/assemkdv/gitguide/actions/workflows/ci.yml/badge.svg)](https://github.com/assemkdv/gitguide/actions/workflows/ci.yml)

GitGuide is a Chrome extension that turns any public GitHub repo into something you can
actually get oriented in within minutes: it explains the repository, a file, or an
issue right on the page, and answers follow-up questions grounded in the real source
code — with citations back to the exact file and line, not a generic model guess.

> **Suggested GitHub repository description:** "AI-powered Chrome extension that
> explains GitHub repos, files, and issues, and answers grounded, cited questions about
> the code — right on the page."

I built it because I kept landing on repos I wanted to contribute to and had no idea
where to start. Docs are usually stale or missing, and figuring out if an issue is
actually approachable means reading through code and comment threads by hand.

## What it does

- **Explain Repository**: purpose, tech stack, structure, where to start reading
- **Explain File**: what it does and how it fits into the project
- **Summarize Issue**: what's being asked and how you'd approach it
- **Find Good First Issue**: surfaces open `good first issue` / `help wanted` issues
- **Ask GitGuide**: chat grounded in the repo's actual source code, with citations that
  link straight back to the file and line range on GitHub, and follow-up questions that
  stay in context within that repository's conversation
- **Caching**: re-open something you already explained and it's instant
- **Streaming**: chat answers show up as they're generated

## Tech stack

| Layer     | Technologies                                                          |
| --------- | ---------------------------------------------------------------------- |
| Extension | TypeScript, React, Zustand, Vite (`@crxjs/vite-plugin`), Manifest V3   |
| Backend   | Node.js, Express, Groq SDK, Zod                                        |
| Tooling   | npm workspaces, Vitest, ESLint, GitHub Actions (CI)                    |

## Getting started

Needs Node 18+, a [Groq](https://console.groq.com) API key, and Chrome.

```bash
git clone https://github.com/assemkdv/gitguide.git
cd gitguide
npm install
cp .env.example .env   # add your GROQ_API_KEY
npm run dev:api        # starts on localhost:3000
npm run build:extension
```

Then load `apps/extension/dist` as an unpacked extension in `chrome://extensions`
(Developer mode → Load unpacked). The build points at the deployed backend by
default; see [Deployment](#deployment) to point it at your local API instead.

`GITHUB_TOKEN` in `.env` is optional and just raises GitHub's rate limit.

## Testing

```bash
npm run lint
npm test
```

Covers URL/ref parsing, cache scoping, cancellation, request validation,
GitHub-identifier validation, and streaming abort behavior. No end-to-end tests yet,
see [Known limitations](#known-limitations). These are the same checks GitHub Actions
runs on every pull request and push to `main` (see the badge at the top).

## How it works

Small monorepo. The extension lives on the page, the backend talks to Groq and the
GitHub API so the Groq key never ends up in the browser.

```
Chrome Extension  →  Backend  →  Groq (LLM)
                         ↓
                   GitHub REST API
```

The extension watches for GitHub page changes and calls the backend on each action.
The backend validates the request, pulls context from GitHub, and asks Groq to
explain it.

## The tricky part

GitHub is a single-page app, so navigating between files never triggers a real page
load, and there's no event for it either. I patch `history.pushState` from a script
running in the page's own JS context so the panel can react the instant the URL
changes.

The other interesting problem: a branch like `release/v2` looks identical to a nested
file path if you're only reading the URL. GitHub embeds the real ref in the page as
JSON, so I read that when it's there. If it's missing, I fall back to checking the
URL against the repo's actual branch and tag names through GitHub's API.

The backend validates every request with Zod, cancels in-flight GitHub/Groq calls if
you navigate away mid-request, and degrades a malformed model response field by field
instead of failing the whole request.

## Ask GitGuide (RAG chat)

Ask GitGuide answers questions from the repository's actual source, rather than a
generic model response. It's a small retrieval-augmented generation (RAG) pipeline,
streamed over SSE, that runs entirely in the API — no data leaves the server except
the question and the retrieved excerpts sent to Groq.

**Retrieval is hybrid.** Each indexed file is chunked (regex-based, preferring to cut at
a function/class boundary over an arbitrary line) and embedded locally — no external
embeddings API — via a small (~25MB quantized) sentence-embedding model
(`Xenova/all-MiniLM-L6-v2`) run in-process through `@huggingface/transformers`. Those
embeddings back a cosine-similarity ("semantic") ranking. In parallel, a small in-house
BM25 index provides a lexical ranking, which catches exact identifier/keyword matches
that a pure embedding search can miss. The two rankings are merged with Reciprocal Rank
Fusion (RRF) — combining rank *position* rather than raw scores, since cosine similarity
and BM25 scores aren't on comparable scales — with a per-file cap so one large file
can't occupy every citation slot. Citations shown in the panel are computed directly
from these retrieved chunks, never parsed out of the model's own output, so they can't
be hallucinated or mismatched.

**Indexing is two-phase and keyed by commit SHA.** The first question against a repo
triggers "Phase A": a small priority subset (README, `docs/`, manifests, likely
entrypoints, plus files matching keywords from the question) is fetched, chunked, and
embedded synchronously — fast enough to answer in a few seconds. The rest of the repo
(up to a file cap) continues indexing in the background ("Phase B") afterward; the panel
shows an "indexing in the background" note on partial answers, and later questions
automatically benefit from Phase B's results with no action needed. The index is cached
under the key `owner/repo@<branch-head-sha>` — resolved fresh via the GitHub API on every
request — so a new commit on that branch is a different cache key and always triggers a
rebuild; a stale index is never served.

**Conversations are scoped per repository.** Each question sends the recent exchange
(up to the last 12 turns) as conversation history, so a follow-up like "what does that
function call?" resolves naturally without re-stating context. Switching to a different
repository (or branch) starts a fresh conversation instead of carrying over the
previous one's history.

**Known limitations, worth knowing before relying on this in production:**
- The index cache is in-process and in-memory only (LRU-evicted, a handful of repos at
  a time) — nothing is persisted to disk. A server restart or Render cold start empties
  it, and the next question on any repo pays the full Phase A cost again.
- The embedding model itself isn't bundled — `@huggingface/transformers` downloads it
  from Hugging Face on first use and keeps it in memory for the process's lifetime. On
  Render's ephemeral filesystem, that means a fresh ~25MB download on every cold
  start/redeploy unless the cache is baked into the build image, which isn't set up yet.
  Its native ONNX runtime also doesn't reliably fit Render's 512MB free instance, so
  `ENABLE_LOCAL_EMBEDDINGS` (see `.env.example`) defaults to off there — retrieval runs
  BM25 lexical search only, and the package is never imported. Set it to `true` on an
  instance with enough memory for hybrid BM25 + semantic retrieval.
- `/v1/ask-repo` is rate-limited tighter than the other routes (15 requests / 15 min per
  IP) since a cache miss can trigger a full repository index, not just one completion.
- As with the rest of the API, `ALLOWED_EXTENSION_IDS` (see
  [Deployment](#deployment)) must be set once the extension has a published Web Store
  ID — otherwise the API accepts this endpoint from any `chrome-extension://` origin.

**Manually testing it:**
1. `npm run dev:api`, load the extension pointed at it (see
   [Getting started](#getting-started)).
2. Open a public GitHub repo, open the panel, click **Ask GitGuide**.
3. Ask something concrete the code should answer, e.g. "where is authentication
   implemented?" — an answer should stream in with citation chips underneath; click one
   and confirm it opens the exact file and line range on GitHub.
4. Pick a repo with more than ~30 indexable files and ask a question immediately after
   opening it — the answer should show "Indexing the rest of the repository in the
   background…"; wait a few seconds and ask a second, more obscure question to confirm
   citations can now come from outside the initial priority set.
5. Ask a follow-up question in the same session and confirm it uses conversation history
   (e.g. "what does that function call?").
6. Switch to a different repo (or branch) mid-conversation and confirm Ask GitGuide's
   history resets rather than answering from the previous repo's index.

## Deployment

Backend runs on Render (`https://gitguide-api.onrender.com`), a plain Node/Express
service. The extension picks up its API URL at build time via `VITE_API_URL`,
defaulting to `localhost:3000`; production builds are pinned to the Render URL.

CORS accepts any `chrome-extension://` origin by default since the extension has no
permanent Web Store ID yet. Once it does, set `ALLOWED_EXTENSION_IDS` (comma-separated
extension ID(s)) in the API's environment so it only accepts that origin — see
`.env.example`.

GitHub Actions runs CI — lint, typecheck, the full test suite, and both production
builds — on every pull request and every push to `main` (see the badge at the top, or
`.github/workflows/ci.yml`). This is CI, not CD: it validates the code but doesn't
deploy anything itself. Render deploys the backend from `main` independently, so a
green CI run before merging is the actual safeguard — Render doesn't enforce it.

## Known limitations

- No end-to-end tests, just unit tests on the pure logic
- Private repos aren't fully supported (no auth path for file content)
- Slash-branch detection has two fallbacks but isn't a guarantee
- A totally broken model response still returns an error instead of degrading
- Cancellation only happens when the connection drops, no explicit cancel signal
- Ask GitGuide's index cache is in-memory and cold-starts on every deploy/restart —
  see [Ask GitGuide](#ask-gitguide-rag-chat) for details
