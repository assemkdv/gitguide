# Browser tests

`npm run test:e2e` builds the extension (development mode, API = `http://localhost:4319`),
loads it into Playwright's Chromium, and drives it against:

- **fixture GitHub pages** served by request routing (`github-fixture.ts`), with a small
  in-page router that mimics GitHub's SPA navigation (`pushState`, delayed repaint,
  `popstate`), plus routed `raw.githubusercontent.com` and `api.github.com`;
- **a mock GitGuide API** on localhost (`mock-api.ts`) whose handlers each test can
  replace (slow responses, errors, dropped streams).

No request leaves the machine; GitHub and Groq are never contacted. First run:
`npx playwright install chromium`.
