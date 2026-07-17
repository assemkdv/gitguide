// The server already builds and sends ready-to-use citation URLs (it has owner/repo/
// ref/path/lines in scope during retrieval), so this pure helper isn't on that path —
// it exists as a tested, reusable single source of truth for building a GitHub
// blob+line-range URL client-side, since no such helper existed anywhere before this.
export function buildBlobUrl(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  startLine: number,
  endLine: number,
): string {
  const lineFragment = startLine === endLine ? `L${startLine}` : `L${startLine}-L${endLine}`;
  return `https://github.com/${owner}/${repo}/blob/${ref}/${path}#${lineFragment}`;
}
