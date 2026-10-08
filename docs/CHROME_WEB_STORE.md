# Chrome Web Store submission kit

Everything needed to submit GitGuide, based on the current Chrome Web Store
documentation (checked 2026-10-07: publishing, Privacy practices tab, MV3 additional
requirements, Limited Use policy, and image requirements). Submitting, paying the
developer registration fee, and publishing are manual steps for the account owner.

## 1. Build the package

```bash
npm ci
npm run package:extension
```

This builds the release extension and verifies it before zipping:

- Manifest V3; the only host permission is the https API origin from
  `apps/extension/.env.production`;
- no source maps, no `.env` files, no `localhost`/loopback URLs, no Vite dev client;
- no Groq keys, GitHub tokens, private keys, `eval(`, or remote `import()`;
- the bundle actually references the permitted API origin.

Output: `release/gitguide-extension-v<version>.zip` (manifest.json at the root) and a
`.sha256` checksum. The ZIP is deterministic: the same source gives the same checksum.
CI uploads it as the `gitguide-extension` artifact on every run.

Before each submission, bump `version` in `apps/extension/manifest.json` (the Store
rejects re-uploading an existing version).

## 2. Store listing

**Name:** GitGuide

**Summary (≤132 characters):**
> Understand public GitHub repositories, files, and issues with AI explanations and answers that link to the exact code.

**Category:** Developer Tools · **Language:** English

**Description:**

> GitGuide helps you get oriented in an unfamiliar public GitHub repository without
> leaving GitHub.
>
> Open the GitGuide panel on any public repository and:
>
> • Explain Repository: purpose, tech stack, structure, and where to start reading.
> • Explain File: what the file does, its main parts, and related files (checked against
> the repository).
> • Summarize Issue: what the issue asks for, the discussion so far, and suggested steps.
> • Find Good First Issue: open "good first issue" and "help wanted" issues.
> • Ask GitGuide: ask questions about the code and get answers based on excerpts from the
> repository, with links to the exact lines on GitHub.
>
> Every answer shows which branch, tag or commit it is based on, and says when it only
> saw part of a large file or repository. AI answers can be wrong: check the linked
> sources.
>
> Privacy: GitGuide works with public repositories only. It sends the GitGuide server
> which repository, file, or issue you're viewing, plus your questions in Ask GitGuide.
> The server reads the public content from GitHub and uses the Groq AI service to answer.
> GitGuide never uses your GitHub login or sends the content of the page you're on.
> Conversations are stored only in your browser, and you can clear them at any time.

**Screenshots** (1280×800, captured from a working build on github.com; see
`docs/store/screenshots/`):

1. `1-data-notice.png`: the notice shown before anything is sent;
2. `2-explain-repository.png`: repository overview;
3. `3-explain-file.png`: file explanation pinned to a tag;
4. `4-ask-gitguide.png`: answer with numbered source links and coverage note.

Screenshots 2–4 were captured with a development build connected to a locally running
copy of this API (live GitHub and Groq); the panel UI is identical to the release build.
Screenshot 1 was captured from a build carrying the production API URL. Re-capture with
`scripts/capture-screenshots.mjs` after visual changes.

**Small promo tile (440×280, required):** `docs/store/promo-small-440x280.png`.
**Store icon:** `apps/extension/public/icons/icon-128.png`.

## 3. Privacy practices tab

**Single purpose:**
> GitGuide helps developers understand public GitHub repositories by explaining the
> repository, file, or issue they are viewing and answering questions about its code.

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| `storage` | Saves the user's Ask GitGuide conversations, cached explanations, their acknowledgement of the data notice, and panel width locally, so they persist across page loads. Users can clear this from the panel. |
| Host permission `https://gitguide-api.onrender.com/*` | The extension's service worker sends the user's requests (which public repository/file/issue, and chat questions) to GitGuide's own API, which generates the explanations. No other site is contacted by the extension's privileged context. |
| Content script on `https://github.com/*` | Shows the GitGuide panel on GitHub and reads the current page address (repository, branch, file path, issue number) to know what to explain. Content is read locally to detect page readiness and changes; it is not transmitted. |

**Remote code:** "No, I am not using remote code." All JavaScript is in the package; the
API returns JSON/text data only, rendered as Markdown without executing scripts or raw
HTML.

**Data usage disclosures** (check these):

- **Website content**: yes. Identifiers of the GitHub page (repository, branch/tag,
  file path, issue number) are sent so the server can fetch public content.
- **User activity / Web history**: **[VERIFY with your own reading of the dashboard
  definitions]**. The extension sends the identifiers above only when the user invokes a
  feature; it does not collect browsing history. Most similar tools answer "No" to web
  history; if in doubt, disclose.
- **Personal communications**: the user's chat questions are user-generated text sent
  for processing. **[VERIFY]**: decide whether to disclose under "Personally
  identifiable information" (users might type it) or note it in the privacy policy only.
- Not collected: personally identifiable information (no accounts), health,
  financial, authentication information, location.

**Certifications** (all three can be truthfully certified by the code as written):
- I do not sell or transfer user data to third parties, outside of the approved use
  cases (the AI provider Groq processes requests to provide the feature).
- I do not use or transfer user data for purposes unrelated to the item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending.

**Privacy policy URL:** host `docs/PRIVACY.md` publicly after completing its **[VERIFY]**
items. The extension links to `VITE_PRIVACY_POLICY_URL` (default
`https://github.com/assemkdv/gitguide/blob/main/docs/PRIVACY.md`, which only works if the
repository is public). The Limited Use statement is included in the policy, as the
policy requires it on a website belonging to the extension.

## 4. Distribution

Recommended first release: **Unlisted** (or a small set of testers), watch logs, Groq
usage, and the daily budget for a week, then make it Public.

## 5. Test instructions for reviewers

> No account or credentials are needed.
>
> 1. Open https://github.com/sindresorhus/slugify (any public repository works).
> 2. Click the round GitGuide button at the bottom right of the page.
> 3. Click "Explain Repository". A notice explains what will be sent; click "I understand,
>    continue". An overview appears within ~10 seconds (the server may take up to a
>    minute to wake up on the first request).
> 4. Open `index.js` in the repository and click "Explain File" (or keep the panel on the
>    file view; it updates automatically).
> 5. Go back to Quick Actions, click "Ask GitGuide", and ask "How does slugifyWithCounter
>    avoid duplicate slugs?". The answer streams in with numbered links to the code; the
>    Stop button cancels an answer in progress.
> 6. On a private repository, GitGuide shows that it supports public repositories only
>    and sends nothing.
> 7. The shield icon in the panel header opens Privacy & data, including "Clear chat
>    history and cached explanations".

## 6. Manual steps for the account owner

1. Register a Chrome Web Store developer account (one-time fee) and enable 2-step
   verification on the Google account.
2. Complete the **[VERIFY]** items in `docs/PRIVACY.md` and host it at a public URL; set
   `VITE_PRIVACY_POLICY_URL` in `apps/extension/.env.production` if it differs from the
   default, then rebuild.
3. Deploy the API changes in this release first (`docs/DEPLOYMENT.md`); the new extension
   requires them.
4. Upload `release/gitguide-extension-v<version>.zip` (New item), fill the listing,
   privacy tab, and test instructions above.
5. Copy the item id from the dashboard into `ALLOWED_EXTENSION_IDS` on Render.
6. Run `docs/SMOKE_TEST.md` against the uploaded/unlisted build, then submit for review.
