// Runtime validation for everything that crosses a trust boundary into the panel: API
// responses, stream events from the service worker, and data read back from
// chrome.storage (which may be from an older version or partially written). Each
// normalizer returns a well-formed value or null — components never see malformed data.
import type {
  AnalysisResult,
  ChatMessage,
  CheckedPath,
  Citation,
  Difficulty,
  ExplainFileQuickResult,
  ExplainFileResult,
  ExplainRepoResult,
  FileMeta,
  GoodFirstIssueItem,
  IndexInfo,
  IssueMeta,
  RepoMeta,
} from './store';

type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean => v === true;
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function objArray<T>(v: unknown, map: (o: Obj) => T | null): T[] {
  return Array.isArray(v) ? v.filter(isObject).map(map).filter((x): x is T => x !== null) : [];
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/** Only github.com https links are rendered as clickable citations. */
export function isGitHubUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function checkedPaths(v: unknown): CheckedPath[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((item): CheckedPath | null => {
      // Results cached by older versions stored plain strings (never verified).
      if (typeof item === 'string') return item ? { path: item, verified: false } : null;
      if (isObject(item) && str(item.path)) return { path: str(item.path), verified: bool(item.verified) };
      return null;
    })
    .filter((x): x is CheckedPath => x !== null);
}

export function normalizeGoodFirstIssue(o: Obj): GoodFirstIssueItem | null {
  const number = num(o.number);
  if (number == null || !str(o.title)) return null;
  return {
    number,
    title: str(o.title),
    labels: strArray(o.labels),
    category: o.category === 'good first issue' ? 'good first issue' : 'help wanted',
    comments: num(o.comments) ?? 0,
  };
}

export function normalizeGoodFirstIssues(v: unknown): GoodFirstIssueItem[] | null {
  return Array.isArray(v) ? objArray(v, normalizeGoodFirstIssue) : null;
}

function repoMeta(v: unknown): RepoMeta | undefined {
  if (!isObject(v) || !SHA_RE.test(str(v.commitSha))) return undefined;
  return {
    ref: str(v.ref),
    commitSha: str(v.commitSha),
    filesInTree: num(v.filesInTree) ?? 0,
    filesShownToModel: num(v.filesShownToModel) ?? 0,
    treeTruncated: bool(v.treeTruncated),
    readmeTruncated: bool(v.readmeTruncated),
    hasReadme: v.hasReadme !== false,
  };
}

export function normalizeRepoResult(v: unknown): ExplainRepoResult | null {
  if (!isObject(v) || !str(v.purpose)) return null;
  return {
    purpose: str(v.purpose),
    techStack: strArray(v.techStack),
    folderStructure: objArray(v.folderStructure, (o) => (str(o.path) ? { path: str(o.path), description: str(o.description) } : null)),
    architecture: objArray(v.architecture, (o) => (str(o.title) ? { title: str(o.title), description: str(o.description) } : null)),
    keyEntrypoints: objArray(v.keyEntrypoints, (o) =>
      str(o.path) ? { path: str(o.path), label: str(o.label), loc: num(o.loc), url: isGitHubUrl(o.url) ? o.url : undefined } : null,
    ),
    dataFlow: str(v.dataFlow),
    authPersistence: str(v.authPersistence),
    howToRun: strArray(v.howToRun),
    beginnerStart: str(v.beginnerStart),
    goodFirstIssues: normalizeGoodFirstIssues(v.goodFirstIssues),
    goodFirstIssuesError: typeof v.goodFirstIssuesError === 'string' ? v.goodFirstIssuesError : null,
    meta: repoMeta(v.meta),
  };
}

function fileMeta(v: unknown): FileMeta | undefined {
  if (!isObject(v) || !SHA_RE.test(str(v.commitSha))) return undefined;
  return {
    ref: str(v.ref),
    commitSha: str(v.commitSha),
    path: str(v.path),
    url: isGitHubUrl(v.url) ? v.url : undefined,
    lines: num(v.lines) ?? 0,
    totalChars: num(v.totalChars) ?? 0,
    analyzedChars: num(v.analyzedChars) ?? 0,
    truncated: bool(v.truncated),
  };
}

export function normalizeFileResult(v: unknown): ExplainFileResult | null {
  if (!isObject(v) || !str(v.purpose)) return null;
  return {
    purpose: str(v.purpose),
    summary: str(v.summary),
    mainComponents: strArray(v.mainComponents),
    inputsOutputs: str(v.inputsOutputs),
    dependencies: strArray(v.dependencies),
    usedBy: str(v.usedBy),
    connections: str(v.connections),
    importantLogic: str(v.importantLogic),
    edgeCases: str(v.edgeCases),
    contributorNotes: str(v.contributorNotes),
    relatedFiles: checkedPaths(v.relatedFiles),
    meta: fileMeta(v.meta),
  };
}

export function normalizeFileQuickResult(v: unknown): ExplainFileQuickResult | null {
  if (!isObject(v) || !str(v.purpose)) return null;
  return { purpose: str(v.purpose), summary: str(v.summary) };
}

const DIFFICULTIES: Difficulty[] = ['beginner', 'intermediate', 'advanced'];

function issueMeta(v: unknown): IssueMeta | undefined {
  if (!isObject(v)) return undefined;
  return {
    issueNumber: num(v.issueNumber) ?? 0,
    title: str(v.title),
    state: str(v.state),
    updatedAt: str(v.updatedAt),
    commentsTotal: num(v.commentsTotal) ?? 0,
    commentsIncluded: num(v.commentsIncluded) ?? 0,
    commitSha: str(v.commitSha),
    ref: str(v.ref),
  };
}

export function normalizeAnalysis(v: unknown): AnalysisResult | null {
  if (!isObject(v) || strArray(v.whatItAsks).length === 0) return null;
  return {
    whatItAsks: strArray(v.whatItAsks),
    whyItMatters: str(v.whyItMatters),
    currentBehavior: str(v.currentBehavior),
    expectedBehavior: str(v.expectedBehavior),
    discussionContext: str(v.discussionContext),
    relevantFiles: objArray(v.relevantFiles, (o) => (str(o.path) ? { path: str(o.path), reason: str(o.reason), verified: bool(o.verified) } : null)),
    implementationSteps: strArray(v.implementationSteps),
    risks: str(v.risks),
    testingConsiderations: str(v.testingConsiderations),
    difficulty: DIFFICULTIES.includes(v.difficulty as Difficulty) ? (v.difficulty as Difficulty) : 'intermediate',
    timeEstimate: str(v.timeEstimate),
    meta: issueMeta(v.meta),
  };
}

export function normalizeCitation(v: unknown): Citation | null {
  if (!isObject(v) || !str(v.path) || !isGitHubUrl(v.url)) return null;
  const startLine = num(v.startLine);
  const endLine = num(v.endLine);
  if (startLine == null || endLine == null) return null;
  return { path: str(v.path), startLine, endLine, url: v.url };
}

export function normalizeIndexInfo(v: unknown): IndexInfo | undefined {
  if (!isObject(v)) return undefined;
  const coverage = isObject(v.coverage) ? v.coverage : {};
  const status = str(v.status);
  return {
    status: status === 'complete' || status === 'failed' || status === 'background-indexing' ? status : 'partial',
    ref: str(v.ref),
    commitSha: SHA_RE.test(str(v.commitSha)) ? str(v.commitSha) : '',
    fullCoverage: bool(v.fullCoverage),
    retrieval: v.retrieval === 'hybrid' ? 'hybrid' : 'lexical',
    indexedFiles: num(coverage.indexedFiles) ?? 0,
    eligibleFiles: num(coverage.eligibleFiles) ?? 0,
    treeTruncated: bool(coverage.treeTruncated),
  };
}

const MESSAGE_STATUSES = new Set(['streaming', 'complete', 'stopped', 'interrupted', 'error']);

export function normalizeChatMessage(v: unknown, fallbackId: string): ChatMessage | null {
  if (!isObject(v) || (v.role !== 'user' && v.role !== 'assistant') || typeof v.content !== 'string') return null;
  const status = MESSAGE_STATUSES.has(str(v.status)) ? (v.status as ChatMessage['status']) : undefined;
  const message: ChatMessage = {
    id: str(v.id) || fallbackId,
    role: v.role,
    content: v.content.slice(0, 20_000),
    // A message saved mid-stream (tab closed) can never resume — show it as interrupted.
    status: status === 'streaming' ? 'interrupted' : status,
  };
  const citations = Array.isArray(v.citations) ? v.citations.map(normalizeCitation).filter((c): c is Citation => c !== null) : [];
  if (citations.length) message.citations = citations;
  const index = normalizeIndexInfo(v.index);
  if (index) message.index = index;
  if (isObject(v.error) && str(v.error.message)) message.error = { code: str(v.error.code), message: str(v.error.message) };
  if (typeof v.finishReason === 'string') message.finishReason = v.finishReason;
  return message;
}
