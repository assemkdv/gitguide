// Directory segments already excluded from every repo tree fetch (getRepoTree). Kept
// as its own module so github.ts and the RAG indexer share one definition — moved here
// verbatim, not widened, so getRepoTree's existing filtering behavior (and therefore
// explain-repo.ts's output) is unchanged by this extraction.
export const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'vendor',
  'coverage',
  '.next',
  '.turbo',
]);

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'composer.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'go.sum',
]);

const BINARY_EXTENSIONS = new Set([
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'avif', 'tiff',
  // fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // archives
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'br',
  // media
  'mp4', 'mov', 'avi', 'webm', 'mp3', 'wav', 'ogg', 'flac',
  // compiled/binary
  'wasm', 'so', 'dylib', 'dll', 'exe', 'class', 'o', 'a', 'bin', 'node',
  // documents / misc generated
  'pdf', 'map', 'lock',
]);

const BINARY_FILENAME_SUFFIXES = ['.min.js', '.min.css'];

/**
 * True when a file (already surviving getRepoTree's directory-segment filtering) is
 * worth fetching/embedding for RAG indexing — excludes lockfiles and binary/minified
 * assets that carry no meaningful semantic content. Separate from IGNORED_DIR_SEGMENTS
 * so this doesn't change getRepoTree's own (directory-only) filtering behavior.
 */
export function isIndexableFile(path: string): boolean {
  const segments = path.split('/');
  const filename = segments[segments.length - 1];
  if (!filename) return false;
  if (LOCKFILE_NAMES.has(filename)) return false;
  if (BINARY_FILENAME_SUFFIXES.some((suffix) => filename.endsWith(suffix))) return false;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return true; // extensionless files (Dockerfile, Makefile, etc.) are indexable
  const ext = filename.slice(dotIndex + 1).toLowerCase();
  return !BINARY_EXTENSIONS.has(ext);
}
