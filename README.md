# GitGuide

GitGuide is a Chrome extension that explains GitHub repos, files, and issues right
inside the page.

I built it because I kept landing on repos I wanted to contribute to and had no idea
where to start. Docs are usually stale or missing, and figuring out if an issue is
actually approachable means reading through code and comment threads by hand.

## What it does

- **Explain Repository**: purpose, tech stack, structure, where to start reading
- **Explain File**: what it does and how it fits into the project
- **Summarize Issue**: what's being asked and how you'd approach it
- **Find Good First Issue**: surfaces open `good first issue` / `help wanted` issues
- **Chat**: follow-up questions grounded in whatever GitGuide already explained
- **Caching**: re-open something you already explained and it's instant
- **Streaming**: chat answers show up as they're generated

## Tech stack

| Layer     | Technologies                                                        |
| --------- | ---------------------------------------------------------------------- |
| Extension | TypeScript, React, Zustand, Vite (`@crxjs/vite-plugin`), Manifest V3   |
| Backend   | Node.js, Express, Groq SDK, Zod                                        |
| Tooling   | npm workspaces, Vitest, ESLint                                         |

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

Covers URL/ref parsing, cache scoping, cancellation, and request validation. No
end-to-end tests yet, see [Known limitations](#known-limitations).

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

## Deployment

Backend runs on Render (`https://gitguide-api.onrender.com`), a plain Node/Express
service. The extension picks up its API URL at build time via `VITE_API_URL`,
defaulting to `localhost:3000`; production builds are pinned to the Render URL.

CORS currently accepts any `chrome-extension://` origin since the extension has no
permanent Web Store ID yet. That'll get locked down once it does.

No CI/CD. Lint, tests, and builds run by hand for now.

## Known limitations

- No end-to-end tests, just unit tests on the pure logic
- Private repos aren't fully supported (no auth path for file content)
- Slash-branch detection has two fallbacks but isn't a guarantee
- A totally broken model response still returns an error instead of degrading
- Cancellation only happens when the connection drops, no explicit cancel signal