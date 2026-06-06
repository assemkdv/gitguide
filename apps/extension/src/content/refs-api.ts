const REFS_FETCH_TIMEOUT_MS = 3000;
const MAX_PAGES_PER_KIND = 3; // caps at 300 branches + 300 tags per repo

async function fetchRefPage(
  owner: string,
  repo: string,
  kind: 'branches' | 'tags',
  page: number,
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/${kind}?per_page=100&page=${page}`, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return [];
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data
    .map((entry: { name?: unknown }) => entry?.name)
    .filter((name): name is string => typeof name === 'string');
}

/**
 * Fetches every branch and tag name for a repo. This is a last resort, not part of the
 * normal file-detection path — it only runs when a slash-containing ref couldn't be
 * resolved any other way (see `resolveRefFromKnownNames` in page-parser.ts), so the
 * extra GitHub API call is rare rather than something that fires on every file view.
 * Capped at 300 refs per kind and a short timeout so a huge repo or a slow response
 * can't hang file detection — returns whatever it managed to fetch, or an empty array
 * on any failure (network error, rate limit, timeout). Never throws.
 */
export async function fetchAllRefNames(owner: string, repo: string): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFS_FETCH_TIMEOUT_MS);

  try {
    const names = new Set<string>();
    for (const kind of ['branches', 'tags'] as const) {
      for (let page = 1; page <= MAX_PAGES_PER_KIND; page++) {
        const batch = await fetchRefPage(owner, repo, kind, page, controller.signal);
        batch.forEach((name) => names.add(name));
        if (batch.length < 100) break;
      }
    }
    return Array.from(names);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const refNamesCache = new Map<string, Promise<string[]>>();

/** Same as `fetchAllRefNames`, but cached per repo for the lifetime of the content
 * script — repeatedly opening files in the same repo during a session should only
 * ever trigger this fallback fetch once. */
export function getRefNames(owner: string, repo: string): Promise<string[]> {
  const key = `${owner}/${repo}`;
  let entry = refNamesCache.get(key);
  if (!entry) {
    entry = fetchAllRefNames(owner, repo);
    refNamesCache.set(key, entry);
  }
  return entry;
}
