// Checks file paths named by the model against the repository's real file tree, so the
// UI can show which suggestions are confirmed files and which are only the model's guess.

export interface CheckedPath {
  /** The canonical repository path when verified, otherwise what the model said. */
  path: string;
  /** True only when the path resolved to a file that exists at the analyzed commit. */
  verified: boolean;
}

const EXTENSION_GUESSES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '/index.ts', '/index.js', '/__init__.py'];

function normalise(segments: string[]): string | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(segment);
  }
  return out.join('/');
}

/** Resolves `candidate` (as the model wrote it — possibly relative, possibly without an
 * extension, possibly wrapped in backticks) to an existing tree path, or null. */
export function resolveRepoPath(candidate: string, treePaths: ReadonlySet<string>, baseDir = ''): string | null {
  const cleaned = candidate.trim().replace(/^`|`$/g, '').replace(/[#?].*$/, '').replace(/^\/+/, '');
  if (!cleaned) return null;

  const bases: (string | null)[] = [normalise(cleaned.split('/'))];
  if (baseDir && (cleaned.startsWith('./') || cleaned.startsWith('../'))) {
    bases.unshift(normalise([...baseDir.split('/'), ...cleaned.split('/')]));
  }
  for (const base of bases) {
    if (!base) continue;
    for (const ext of EXTENSION_GUESSES) {
      if (treePaths.has(base + ext)) return base + ext;
    }
  }

  // A bare file name ("auth.ts") counts only when exactly one file in the tree has it.
  if (!cleaned.includes('/')) {
    const matches = [...treePaths].filter((p) => p === cleaned || p.endsWith(`/${cleaned}`));
    if (matches.length === 1) return matches[0];
  }
  return null;
}

export function checkPaths(candidates: string[], treePaths: ReadonlySet<string>, baseDir = ''): CheckedPath[] {
  return candidates
    .filter((c) => c.trim().length > 0)
    .map((candidate) => {
      const resolved = resolveRepoPath(candidate, treePaths, baseDir);
      return resolved ? { path: resolved, verified: true } : { path: candidate.trim(), verified: false };
    });
}

/** github.com blob link pinned to an exact commit, with every path segment encoded. */
export function blobUrl(owner: string, repo: string, commitSha: string, path: string, startLine?: number, endLine?: number): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${commitSha}/${encodedPath}`;
  if (startLine == null) return base;
  return endLine != null && endLine !== startLine ? `${base}#L${startLine}-L${endLine}` : `${base}#L${startLine}`;
}
