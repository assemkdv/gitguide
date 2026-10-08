import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1, 'must not be empty');

// repoOwner/repoName are interpolated directly into GitHub API/raw-content URLs
// server-side (github.ts) — a loose "any non-empty string" schema would let a caller
// that bypasses the extension (CORS's Origin check only stops honest browsers, not a
// direct script) inject path- or query-breaking characters into those URLs. Conservative
// allowlists matching GitHub's own username/repo-name rules close that off without
// rejecting any real repo.
const GITHUB_OWNER_RE = /^[a-zA-Z0-9](?:-?[a-zA-Z0-9])*$/;
const repoOwnerSchema = nonEmptyString
  .max(39, 'must be a valid GitHub username or organization')
  .regex(GITHUB_OWNER_RE, 'must be a valid GitHub username or organization');

const GITHUB_REPO_RE = /^[a-zA-Z0-9_.-]+$/;
const repoNameSchema = nonEmptyString
  .max(100, 'must be a valid GitHub repository name')
  .regex(GITHUB_REPO_RE, 'must be a valid GitHub repository name')
  // The character class above would otherwise accept the path-traversal-shaped "." and
  // "..", which are not valid GitHub repo names.
  .refine((name) => name !== '.' && name !== '..', 'must be a valid GitHub repository name');

// Shared by every route — every request body includes which repo it's about.
export const repoIdentitySchema = z.object({
  repoOwner: repoOwnerSchema,
  repoName: repoNameSchema,
});

// A git ref (branch, tag, or commit SHA) — also interpolated into GitHub API/raw-content
// URLs, so it gets the same treatment: reject ".." traversal segments and characters git
// itself disallows in ref names, while still allowing slash-containing branch names like
// "release/v2" (see git-check-ref-format(1) for the fuller rule set this is a deliberately
// conservative subset of).
const REF_SEGMENT_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.startsWith('/') || ref.endsWith('/') || ref.includes('//')) return false;
  return ref
    .split('/')
    .every((segment) => segment.length > 0 && REF_SEGMENT_RE.test(segment) && !segment.startsWith('.') && !segment.endsWith('.lock'));
}
const gitRefSchema = z.string().max(200).refine(isValidGitRef, 'must be a valid git branch, tag, or commit SHA');

// A repo-relative file path. Real file paths can contain characters a ref name can't
// (spaces, brackets, unicode, etc.), so this doesn't restrict to an alphanumeric
// allowlist like repoOwner/repoName/ref above — it only rejects the shapes that would
// break a URL/filesystem path or represent traversal: a leading slash, "\" or a null
// byte anywhere, and empty/"."/".." segments.
function isValidRepoFilePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}
const filePathSchema = z.string().max(1000).refine(isValidRepoFilePath, 'must be a valid repository-relative file path');

// Requests carry identifiers only — never page content. The server reads files and
// issues itself from GitHub (public repositories only), at an exact commit, so nothing
// the user's browser rendered (e.g. a private repository's DOM) is ever transmitted.

export const explainRepoSchema = repoIdentitySchema.extend({
  // Optional branch/tag/SHA; defaults to the repository's default branch.
  ref: gitRefSchema.optional(),
});

export const explainFileSchema = repoIdentitySchema.extend({
  ref: gitRefSchema,
  filePath: filePathSchema,
});

export const analyzeSchema = repoIdentitySchema.extend({
  issueNumber: z.number().int().positive().max(100_000_000),
});

export const goodFirstIssuesSchema = repoIdentitySchema;

export const askRepoSchema = z.object({
  question: nonEmptyString.max(2000),
  context: z.object({
    repoOwner: repoOwnerSchema,
    repoName: repoNameSchema,
    // The ref being viewed (file pages); omitted elsewhere, in which case the route
    // uses the repository's default branch.
    ref: gitRefSchema.optional(),
  }),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(4000),
      }),
    )
    .max(12)
    .optional(),
});
