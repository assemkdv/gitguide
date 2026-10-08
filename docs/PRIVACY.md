# GitGuide Privacy Policy (DRAFT)

> **Draft — not yet published.** This text describes what the code in this repository
> does. Items marked **[VERIFY]** depend on facts outside the code (who operates the
> service, hosting and provider retention terms) and must be confirmed and filled in by
> the operator before this policy is published or linked from the Chrome Web Store.

_Last updated: [VERIFY: publication date]_

GitGuide is a Chrome extension that explains **public** GitHub repositories, files, and
issues, and answers questions about their code. It is operated by **[VERIFY: operator
name and contact email]**.

## Summary

- GitGuide works with **public GitHub repositories only**.
- It sends the GitGuide server the identifiers of what you are viewing (repository,
  branch/tag, file path, issue number) and, for Ask GitGuide, your question and recent
  messages in that conversation.
- The server reads the public content from GitHub itself and sends it, with your
  question, to the AI provider **Groq** to generate an answer.
- GitGuide does not send your GitHub login, cookies, browsing history, or the contents of
  the page you are on, and does not sell or share data for advertising.
- Conversations and cached explanations are stored only in your browser until you clear
  them.

## What the extension reads in your browser

The extension runs only on `https://github.com/*`. On those pages it reads, **locally**:

- the page address, to know which repository, branch/tag, file, or issue you are viewing;
- the rendered file or issue text, to know when the page has finished loading and to
  notice when content changed since a saved explanation. This text stays in your browser;
- whether GitHub marks the repository as private, so GitGuide can refuse before sending
  anything.

To detect when a file has loaded, the extension may also download that public file
directly from GitHub (`raw.githubusercontent.com`), or list a repository's branch and tag
names from GitHub's API (`api.github.com`). These requests go only to GitHub, without
your GitHub credentials.

## What is sent to the GitGuide server

Only after you choose an action (a short note under Quick Actions summarizes this, and
the panel's Privacy & data screen gives the details), the extension sends the GitGuide API at **[VERIFY: production API URL, currently
`https://gitguide-api.onrender.com`]**:

| Feature | Data sent |
| --- | --- |
| Explain Repository / Find Good First Issue | repository owner and name |
| Explain File | repository owner and name, branch/tag/commit, file path |
| Summarize Issue | repository owner and name, issue number |
| Ask GitGuide | repository owner and name, branch/tag (on file pages), your question, and up to 12 previous messages of that conversation |

Like any web request, these also reveal your IP address and browser user agent to the
server and its hosting provider.

If GitGuide detects that a repository is private, it sends nothing. The server also
independently refuses any repository that GitHub does not report as public.

## What the GitGuide server does with it

The server:

1. reads the requested public content from GitHub (repository metadata, file tree,
   README, file contents, issue text and comments), using a server-side GitHub token
   with no access to private data **[VERIFY: token scope as configured]**;
2. sends that content and your question/conversation to **Groq** to generate the answer;
3. returns the answer to your browser.

To answer questions, the server keeps an **in-memory** index of public repository code
for a short time (a small number of repositories, evicted as new ones are used, and lost
whenever the server restarts). It does **not** store your questions or answers in a
database.

**Logs.** The server's operational logs record, per request: the endpoint, status code,
duration, a random request id, and the number of proxy hops in the forwarding header. The
code does not log request bodies, questions, answers, repository names, file contents, or
IP addresses. The hosting provider may keep its own access logs (including IP addresses)
**[VERIFY: hosting provider (Render) log retention]**.

**Rate limits.** To prevent abuse, the server counts requests per IP address in memory
for 15-minute windows. These counters are not stored or shared.

## AI provider (Groq)

Prompts sent to Groq contain public repository content and, for Ask GitGuide, your
question and conversation history. Groq processes this to generate the response.
**[VERIFY: Groq's data retention and training terms for the account used, and link to
Groq's privacy policy / data processing terms.]** Do not include secrets or personal
information in questions.

## Data stored on your device

In `chrome.storage.local` (this browser profile only):

- Ask GitGuide conversations, per repository (most recent 60 messages each), until you
  clear them;
- cached explanations (repository: 30 minutes; files and issues: 24 hours);
- your preferred panel width.

You can delete conversations and cached explanations at any time from the panel
(**Privacy & data → Clear chat history and cached explanations**) or per repository with
**Clear** in Ask GitGuide. Removing the extension deletes all of it.

## What GitGuide does not do

- It does not use your GitHub session, cookies, or credentials.
- It does not collect browsing history or activity outside the GitHub pages you use it on.
- It does not sell data, use it for advertising, or transfer it except as described above
  (to GitHub to read public content and to Groq to generate answers).
- The use of information received from users complies with the Chrome Web Store User
  Data Policy, including the Limited Use requirements.

## Children

GitGuide is a developer tool and is not directed at children.

## Changes and contact

Material changes will be reflected in this policy and in the extension's Privacy & data
screen. Questions: **[VERIFY: contact email]**.
