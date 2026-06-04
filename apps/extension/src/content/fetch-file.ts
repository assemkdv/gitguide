const RAW_FETCH_TIMEOUT_MS = 2500;

/**
 * Fetches a file's content directly from GitHub's raw content host, bypassing the
 * rendered DOM entirely. This is the primary path for getting file content — it's
 * independent of how long GitHub's own page takes to paint the code viewer. Returns
 * null on any failure (network, timeout, 404) so the caller can fall back to DOM
 * extraction; never throws.
 */
export async function fetchRawFileContent(
  repoOwner: string,
  repoName: string,
  ref: string,
  filePath: string,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${repoOwner}/${repoName}/${ref}/${filePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RAW_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const text = await res.text();
    return text.slice(0, 8000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
