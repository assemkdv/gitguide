import { IGNORED_DIR_SEGMENTS } from './ignore-list';

const GITHUB_API = 'https://api.github.com';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

export interface RepoInfo {
  description: string | null;
  defaultBranch: string;
  language: string | null;
  topics: string[];
}

export async function getRepoInfo(owner: string, repo: string, signal?: AbortSignal): Promise<RepoInfo> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`GitHub repo lookup failed: ${res.status}`);
  const data: any = await res.json();
  return {
    description: data.description ?? null,
    defaultBranch: data.default_branch ?? 'main',
    language: data.language ?? null,
    topics: Array.isArray(data.topics) ? data.topics : [],
  };
}

// The literal commit SHA at the tip of `branch` — used as the RAG index's cache key so
// a new commit (any file changed) automatically invalidates the cached index for that
// branch. `branch` is inserted unencoded (consistent with getRepoTree below) since
// GitHub's ref path accepts slash-containing branch names as literal path segments.
export async function getBranchHeadSha(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { headers: authHeaders(), signal },
  );
  if (!res.ok) throw new Error(`GitHub ref lookup failed: ${res.status}`);
  const data: any = await res.json();
  const sha = data?.object?.sha;
  if (typeof sha !== 'string' || !sha) throw new Error('GitHub ref lookup returned no sha');
  return sha;
}

export async function getReadme(owner: string, repo: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, { headers: authHeaders(), signal });
  if (!res.ok) return '';
  const data: any = await res.json();
  if (!data.content) return '';
  const decoded = Buffer.from(data.content, 'base64').toString('utf-8');
  return decoded.slice(0, 3000);
}

export async function getRepoTree(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: authHeaders(), signal },
  );
  if (!res.ok) return [];
  const data: any = await res.json();
  if (!Array.isArray(data.tree)) return [];

  return data.tree
    .filter((entry: { type: string; path: string }) => entry.type === 'blob')
    .map((entry: { path: string }) => entry.path)
    .filter((path: string) => !path.split('/').some((seg) => IGNORED_DIR_SEGMENTS.has(seg)))
    .slice(0, 500);
}

export interface GoodFirstIssue {
  number: number;
  title: string;
  labels: string[];
  category: 'good first issue' | 'help wanted';
  comments: number;
}

export async function getGoodFirstIssues(owner: string, repo: string, signal?: AbortSignal): Promise<GoodFirstIssue[]> {
  const query = `repo:${owner}/${repo} is:issue is:open label:"good first issue","help wanted"`;
  const res = await fetch(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}&sort=comments&order=desc&per_page=10`,
    { headers: authHeaders(), signal },
  );
  if (!res.ok) return [];
  const data: any = await res.json();
  if (!Array.isArray(data.items)) return [];

  return data.items.map((item: any) => {
    const labels: string[] = (item.labels ?? []).map((l: any) => l.name);
    const isGoodFirst = labels.some((l) => l.toLowerCase().includes('good first issue'));
    return {
      number: item.number,
      title: item.title,
      labels,
      category: isGoodFirst ? 'good first issue' : 'help wanted',
      comments: item.comments ?? 0,
    };
  });
}

export async function getFileContent(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
    { signal },
  );
  if (!res.ok) return '';
  return res.text();
}
