# GitGuide

[![CI](https://github.com/assemkdv/gitguide/actions/workflows/ci.yml/badge.svg)](https://github.com/assemkdv/gitguide/actions/workflows/ci.yml)

GitGuide is a Chrome extension that helps you get oriented in any **public** GitHub
repository within minutes: it explains the repository, a file, or an issue right on the
page, and answers follow-up questions from the real source code, with citations back to
the exact file and lines.

I built it because I kept landing on repos I wanted to contribute to and had no idea
where to start. Docs are usually stale or missing, and figuring out if an issue is
actually approachable means reading through code and comment threads by hand.

## What it does

- **Explain Repository**: purpose, tech stack, structure, where to start reading
- **Explain File**: what it does, its main parts, and related files (checked against the
  repository)
- **Summarize Issue**: what's being asked, the discussion, and suggested steps
- **Find Good First Issue**: open `good first issue` / `help wanted` issues
- **Ask GitGuide**: chat about the code, with numbered citations that link to the exact
  lines at the commit the answer used; Stop and Retry; answers render as Markdown
- Every result says which branch/tag/commit it is based on, and says so when it only saw
  part of a large file or repository.

## Privacy model

GitGuide supports **public repositories only**. A short note under Quick Actions says
where data goes, without blocking anything; the Privacy & data screen has the details:

- the extension sends only *identifiers* (repository, branch/tag, file path, issue
  number) and, for chat, your question and recent messages; never page content, cookies,
  or your GitHub session;
- the server reads public content from GitHub itself, refuses any repository GitHub
  doesn't report as public, and sends the content to Groq to generate the answer;
- conversations and cached explanations stay in your browser and can be cleared from the
  panel (shield icon → Privacy & data).

Details: [docs/PRIVACY.md](docs/PRIVACY.md) (draft).

## Tech stack

| Layer     | Technologies                                                          |
| --------- | ---------------------------------------------------------------------- |
| Extension | TypeScript, React, Zustand, react-markdown, Vite (`@crxjs/vite-plugin`), Manifest V3 |
| Backend   | Node.js, Express, Groq SDK, Zod                                        |
| Tooling   | npm workspaces, Vitest, Playwright, ESLint, GitHub Actions (CI)        |

## Getting started

Needs **Node 22.13+** (see `.nvmrc`; the root `engines` field matches the strictest
dependency requirement), a [Groq](https://console.groq.com) API key, and Chrome 116+.

```bash
git clone https://github.com/assemkdv/gitguide.git
cd gitguide
npm ci
cp .env.example .env            # add GROQ_API_KEY (and optionally GITHUB_TOKEN)
npm run dev:api                 # API on http://localhost:3000
npm run build:extension:dev     # extension pointed at localhost
```

Load `apps/extension/dist` as an unpacked extension (`chrome://extensions` → Developer
mode → Load unpacked).

Builds:

| Command | API URL | Use |
| --- | --- | --- |
| `npm run build:extension:dev` | `http://localhost:3000` (`.env.development`) | local development |
| `npm run build:extension` | `https://gitguide-api.onrender.com` (`.env.production`) | release; refuses non-https/localhost URLs |
| `npm run package:extension` | as release | release build + checks + Web Store ZIP in `release/` |

The manifest's only host permission is derived from the configured API URL at build time.

## Testing

```bash
npm run lint
npm run typecheck
npm test            # API + extension unit/integration tests (Vitest)
npm run test:e2e    # built extension in real Chromium (Playwright)
```

- Unit/integration tests cover ref resolution, GitHub failure handling, the indexing
  lifecycle (retries, eviction, shared-job cancellation, limits), structured errors, SSE
  parsing, request ownership across navigation, chat hydration/Stop/Retry, storage
  quotas, and data validation.
- Browser tests load the built MV3 extension into Chromium against fixture GitHub pages
  (with SPA navigation) and a mock API: navigation races, back/forward, branch switches,
  chat streaming/interruption/Stop, API errors, private repositories, keyboard handling,
  and panel layout. They don't contact GitHub or Groq.
- `apps/api/src/eval/retrieval-eval.test.ts` measures retrieval quality on this repo.

CI runs all of the above, on Node 22 and 24, on every pull request and push to `main`.

## How it works

```
GitHub page ── content script (panel) ──port──► service worker ──HTTPS──► API ──► Groq
                                                                          │
                                                                          └──► GitHub REST / raw
```

- **SPA navigation.** GitHub never reloads the page between files, so a script in the
  page's own JS world patches `history.pushState` and signals the panel.
- **Slash-containing branches.** `release/v2` looks like a nested path in the URL; the
  panel reads GitHub's embedded page data (or the repo's branch/tag list) to split the
  ref from the path.
- **Request ownership.** Every Quick Action request records the exact target it was
  started for (repository, ref, path, or issue). Only the latest request for a target
  that is still on screen may update the panel; obsolete requests are aborted.
- **Immutable snapshots.** The API resolves any branch, tag (including annotated tags) or
  SHA to a commit SHA, then reads the tree, README, and files from that commit. Citation
  links point at that commit, so they always show the code the answer used.
- **Service-worker relay.** All API calls go through the extension's service worker, so
  they come from the extension's origin (not github.com) and aren't blocked by Chrome's
  Local Network Access rules during local development.
- **Grounding.** Repository text is passed to the model as delimited, untrusted data;
  prompts tell the model to say what's missing instead of guessing; paths the model
  names are checked against the real file tree and labeled.

## Ask GitGuide (retrieval)

Each question runs a small retrieval-augmented generation pipeline, streamed over SSE.

**Retrieval in production is keyword-based (BM25).** Files are chunked (preferring
function/class boundaries) and indexed with a BM25 scorer that also splits camelCase
identifiers, applies light stemming, and indexes each chunk's file path. A semantic
(embedding) ranking fused with Reciprocal Rank Fusion is available but **disabled on
the deployed server** (`ENABLE_LOCAL_EMBEDDINGS=false`), because the local ONNX model
doesn't fit a 512 MB instance.

On 16 representative questions about this repository (`retrieval-eval.test.ts`,
keyword-only), the expected file is ranked first for 9, in the top 3 for 12, and in the
top 8 (what the model sees) for 15.

**Indexing is two-phase, per commit.** The first question indexes a priority subset
(README, docs, manifests, files matching the question) synchronously; the rest continues
in the background. Limits: 200 files, 100 KB per file, 3 MB and 3,000 chunks per repo.
Each answer reports how many files were searched, and never claims full coverage when
files were skipped, limited, or GitHub truncated the tree. Background indexing that
fails is retried on a later question (up to 3 attempts, with cooldown).

**Conversations are per repository**, stored locally. Answers record the ref/commit they
used; if you move to a different branch, the panel says new questions will use it.

## Deployment

The API runs on Render; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) (environment,
health/readiness checks, proxy-trust verification, rollback) and `render.yaml`. The
Chrome Web Store kit (listing copy, permission justifications, privacy answers, reviewer
instructions, screenshots) is in [docs/CHROME_WEB_STORE.md](docs/CHROME_WEB_STORE.md),
and the release checklist in [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md).

**CORS is not authentication.** The API accepts browser requests only from the extension
origin, but anyone can call it with a script; per-IP rate limits, a global concurrency
cap, and a daily AI budget are the actual cost controls.

## Known limitations

- Public repositories only.
- Server state (index cache, rate-limit counters, daily budget) is in memory, per
  instance, and resets on restart. The free Render plan also cold-starts after idle.
- Keyword-only retrieval in production can miss questions phrased very differently from
  the code.
- File explanations analyze at most the first 6,000 characters of a file (shown in the
  panel); issue analysis reads up to 12 comments.
- Issue file suggestions are based on file names, not file contents (labeled as such).
