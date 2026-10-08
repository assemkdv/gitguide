# Release smoke test (manual, ~15 minutes)

Run against the **release ZIP** loaded unpacked (unzip it, then `chrome://extensions` →
Developer mode → Load unpacked) or the unlisted Web Store build, with the API deployed
from the same commit. Use a fresh Chrome profile. Record the date, extension version,
API commit, and Chrome version with the results.

Automated coverage for most of these flows runs in CI (`npm run test:e2e`, fixture pages
and a mock API). This checklist is what that cannot cover: real github.com markup, the
deployed API, Groq, and the packaged build.

## API

- [ ] `curl https://<api>/ready` shows `ok: true`, `models.check.status: "ok"`,
      `githubTokenConfigured: true`, `extensionIdsConfigured: true`.
- [ ] `curl -X POST https://<api>/v1/explain-repo -H 'Content-Type: application/json' -d '{}'`
      returns **403 FORBIDDEN_ORIGIN** (no Origin) as JSON, not an HTML/stack page.
- [ ] Render logs show a `request` line with an `xff` count matching `TRUST_PROXY_HOPS`.

## First run and privacy

- [ ] On https://github.com/sindresorhus/slugify, the launcher button appears bottom-right;
      the panel opens and closes (button, ×, Escape); focus returns to the launcher.
- [ ] First Quick Action shows "Before GitGuide sends anything". "Not now" sends nothing
      (DevTools → service worker → Network is empty).
- [ ] "I understand, continue" runs the action. Reloading the page does not show the
      notice again.
- [ ] On a private repository you can access (signed in), any action shows the
      public-only message and the service worker's Network tab shows no request.
- [ ] Privacy & data (shield icon) → Clear… → Delete removes conversations
      (re-open Ask GitGuide: empty).

## Features on real GitHub

- [ ] Explain Repository shows an overview and "Based on main @ <sha>".
- [ ] Open `index.js`; Explain File shows a quick preview, then the full explanation;
      "Related files" marks real files as **exists**.
- [ ] Switch the branch/tag selector to `v2.2.1` while on `index.js`: the explanation
      changes to the tag ("Based on v2.2.1 @ d572cba").
- [ ] Click another file in the tree (SPA navigation): the panel never shows the
      previous file's explanation. Back/forward buttons show the right file each time.
- [ ] On a large file (> 6,000 characters), the "Only the first … characters" notice shows.
- [ ] Summarize Issue on an open issue; navigate to another issue: the new issue is
      analyzed. "Possibly relevant files" are labeled exists/suggestion.
- [ ] Find Good First Issue lists issues (or explains that none/couldn't be loaded).
- [ ] Refresh re-requests an explanation.

## Ask GitGuide

- [ ] Enter sends; Shift+Enter adds a new line; typing letters like `s`/`t` in the box
      does not trigger GitHub shortcuts.
- [ ] The answer streams, renders Markdown and code blocks (Copy works), and has numbered
      source links that open the exact lines at a commit SHA in a new tab.
- [ ] The note under the answer shows the ref/commit and how many files were searched.
- [ ] Stop during an answer: the partial answer stays, marked "Stopped.", Retry works.
- [ ] Turn off Wi-Fi mid-answer: the answer is marked interrupted/failed (not complete),
      and Retry works after reconnecting.
- [ ] Close and reopen the panel, reload the page: the conversation is still there.
- [ ] Navigate to another repository: its own (empty or saved) conversation is shown.

## Layout

- [ ] Drag the panel edge to resize; reload: the width is kept. Keyboard: focus the
      resize handle (Tab) and use ←/→.
- [ ] Narrow the window below ~760 px: the panel overlays the page instead of squeezing it.
- [ ] GitHub's own header, file tree, and code view stay usable with the panel open.
