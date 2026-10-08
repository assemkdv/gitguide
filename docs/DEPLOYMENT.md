# Deploying the GitGuide API (Render)

The API is a plain Node/Express service. These steps are written for the existing Render
web service (`gitguide-api.onrender.com`) and are safe to repeat. Nothing in this
repository deploys automatically; every step below is manual.

## 1. Requirements

- Node **22.13+** (the same lower bound as the root `package.json` `engines` field; CI
  tests Node 22 and 24). Render: set `NODE_VERSION=22`.
- A Groq API key.
- Recommended: a GitHub token (raises GitHub's limit from 60 to 5,000 requests/hour). Use
  a **fine-grained personal access token with no repository permissions** (public data
  only). The server refuses private repositories even if a token could read them.

## 2. Configure the service

Either apply `render.yaml` as a Blueprint (Render → New → Blueprint, select this repo), or
set the same values on the existing service (Settings and Environment):

| Setting | Value |
| --- | --- |
| Build command | `npm ci --include=dev && npm run build:api` |
| Start command | `node apps/api/dist/index.js` |
| Health check path | `/ready` |
| Auto-deploy | **After CI checks pass** (`autoDeployTrigger: checksPass`) |

Environment variables (see `.env.example` for all of them):

| Variable | Production value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | Enables production warnings; disables the dev-server CORS origin. |
| `NODE_VERSION` | `22` | |
| `GROQ_API_KEY` | secret | Required. The server refuses to start without it. |
| `GITHUB_TOKEN` | secret | Recommended (see above). |
| `ALLOWED_EXTENSION_IDS` | your Web Store extension id | Set as soon as the item exists in the developer dashboard (the id is assigned at first upload, before publishing). |
| `TRUST_PROXY_HOPS` | `1`, then verify (step 4) | Number of proxies in front of the app. |
| `ENABLE_LOCAL_EMBEDDINGS` | `false` | Keyword-only retrieval; embeddings need more than 512 MB RAM. |
| `GROQ_MODEL_LARGE` / `GROQ_MODEL_SMALL` | unset (defaults `openai/gpt-oss-120b` / `openai/gpt-oss-20b`) | Override only after checking the model list for your key. |
| `MAX_CONCURRENT_AI_REQUESTS` | `6` | Global cap on simultaneous AI calls. |
| `DAILY_AI_REQUEST_BUDGET` | `3000` | Global AI calls per UTC day; `0` disables. Size it to your Groq plan. |

> **Before the next deploy:** the previous code used `llama-3.3-70b-versatile` and
> `llama-3.1-8b-instant`, which the provider no longer offers to the key in this
> repository's `.env` (verified 2026-10-07: `model_not_found`). If production uses the
> same key, AI features are currently failing there. Check the production logs for
> `model_check` / `upstreamCode":"model_not_found"` after deploying.

## 3. Deploy

1. Merge to `main` and wait for CI (lint, typecheck, unit tests, release package, browser
   tests) to pass. With `checksPass`, Render deploys only then.
2. Watch the deploy logs for:
   - `{"msg":"listening",...}`;
   - `{"msg":"model_check","status":"ok"}` (if it says `missing`, every AI request will
     fail: fix `GROQ_MODEL_*`);
   - any `config_warning` lines (missing `GITHUB_TOKEN` / `ALLOWED_EXTENSION_IDS`).
3. Check readiness:

   ```bash
   curl -s https://gitguide-api.onrender.com/ready
   ```

   Expect `"ok": true`, `"models": {"check": {"status": "ok"}}`, and
   `"githubTokenConfigured": true`, `"extensionIdsConfigured": true` once those are set.
   The endpoint shows no secrets or user data.

## 4. Verify proxy trust (rate limits depend on it)

Per-IP rate limits key on `req.ip`, which Express derives from `X-Forwarded-For` using
`TRUST_PROXY_HOPS`. Render does not document a fixed hop count (community reports vary),
so verify it on the live service:

1. From your own machine, send a request **without** an `X-Forwarded-For` header:

   ```bash
   curl -s -o /dev/null https://gitguide-api.onrender.com/ready
   ```

2. In the Render logs, find that request's line (`"route":"/ready"`) and read `"xff"`:
   the number of addresses the proxies added.
3. Set `TRUST_PROXY_HOPS` to that number (usually `1`). If it is wrong, either all users
   share one rate-limit bucket (too low) or clients can spoof their address to escape
   limits (too high).

## 5. Operational notes

- **Logs** are JSON lines: one `request` line per request (route, status, ms, request id,
  `xff` count) and `route_error` lines with an error code and, for AI-provider failures,
  the provider's status and error type. No questions, answers, repository names, file
  contents, or IP addresses are logged.
- **Shutdown**: on `SIGTERM` the service returns 503 `SHUTTING_DOWN` for new requests,
  cancels indexing, and exits after in-flight responses finish (10 s grace).
- **State is in memory**: the repository index cache, per-IP counters, concurrency
  limiter, and daily budget all reset on restart and are per instance. Run a single
  instance, or move them to a shared store before scaling out.
- **Cold starts** (free plan): the first request after idle can take ~1 minute; the
  extension's error message mentions this.
- **CORS is not authentication.** The Origin check only stops other websites from using
  a visitor's browser to call the API. Anyone can call it directly with a script; the
  per-IP limits, global concurrency cap, and daily budget are the real cost controls.
  Never put a shared secret in the extension.

## 6. Rollback

Render → the service → Events → choose the previous successful deploy → **Rollback**.
The extension does not need to change for an API rollback unless the API contract
changed (this release changed it: request bodies now carry identifiers only, so roll
back the API and extension together if needed).

## 7. Local development

```bash
cp .env.example .env            # add GROQ_API_KEY
npm ci
npm run dev:api                  # http://localhost:3000
npm run build:extension:dev      # extension pointed at localhost, in apps/extension/dist
```

Load `apps/extension/dist` in `chrome://extensions` (Developer mode → Load unpacked).
All API calls go through the extension's service worker, so Chrome's Local Network
Access restrictions on github.com pages do not block the localhost API.
