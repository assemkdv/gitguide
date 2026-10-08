import { create } from 'zustand';
import type { UiError } from './api-client';

export type { UiError };
export type PanelView = 'home' | 'result' | 'chat' | 'empty' | 'consent' | 'settings';
export type PageKind = 'repo' | 'file' | 'issue';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type CardType = 'repo' | 'file' | 'issue' | 'good-first-issues';

// Pipeline stages for turning a detected file route into ready-to-analyze content.
export type FileDetectionStage = 'file_detected' | 'waiting_for_content' | 'content_extracted' | 'request_started' | 'complete';

export interface PageContext {
  repoOwner: string;
  repoName: string;
  page: PageKind;
  filePath?: string;
  fileRef?: string;
  /** Read locally from the page/raw file to know when the file is ready and to detect
   * changes for cache invalidation. Never sent to the GitGuide server. */
  fileContent?: string;
  issueNumber?: number;
  /** Read locally from the page for readiness and change detection; never sent. */
  issueTitle?: string;
  issueBody?: string;
  issueComments?: string;
}

export interface CheckedPath {
  path: string;
  /** Exists in the repository at the analyzed commit. */
  verified: boolean;
}

export interface RelevantFile extends CheckedPath {
  reason: string;
}

export interface ArchitectureItem {
  title: string;
  description: string;
}

export interface EntrypointItem {
  path: string;
  label: string;
  loc: number | null;
  url?: string;
}

export interface FolderItem {
  path: string;
  description: string;
}

export interface GoodFirstIssueItem {
  number: number;
  title: string;
  labels: string[];
  category: 'good first issue' | 'help wanted';
  comments: number;
}

export interface RepoMeta {
  ref: string;
  commitSha: string;
  filesInTree: number;
  filesShownToModel: number;
  treeTruncated: boolean;
  readmeTruncated: boolean;
  hasReadme: boolean;
}

export interface ExplainRepoResult {
  purpose: string;
  techStack: string[];
  folderStructure: FolderItem[];
  architecture: ArchitectureItem[];
  keyEntrypoints: EntrypointItem[];
  dataFlow: string;
  authPersistence: string;
  howToRun: string[];
  beginnerStart: string;
  /** null when the lookup failed (see goodFirstIssuesError) — not the same as "none". */
  goodFirstIssues: GoodFirstIssueItem[] | null;
  goodFirstIssuesError: string | null;
  meta?: RepoMeta;
}

export interface ExplainFileQuickResult {
  purpose: string;
  summary: string;
}

export interface FileMeta {
  ref: string;
  commitSha: string;
  path: string;
  url?: string;
  lines: number;
  totalChars: number;
  analyzedChars: number;
  truncated: boolean;
}

export interface ExplainFileResult {
  purpose: string;
  summary: string;
  mainComponents: string[];
  inputsOutputs: string;
  dependencies: string[];
  usedBy: string;
  connections: string;
  importantLogic: string;
  edgeCases: string;
  contributorNotes: string;
  relatedFiles: CheckedPath[];
  meta?: FileMeta;
}

export interface IssueMeta {
  issueNumber: number;
  title: string;
  state: string;
  updatedAt: string;
  commentsTotal: number;
  commentsIncluded: number;
  commitSha: string;
  ref: string;
}

export interface AnalysisResult {
  whatItAsks: string[];
  whyItMatters: string;
  currentBehavior: string;
  expectedBehavior: string;
  discussionContext: string;
  relevantFiles: RelevantFile[];
  implementationSteps: string[];
  risks: string;
  testingConsiderations: string;
  difficulty: Difficulty;
  timeEstimate: string;
  meta?: IssueMeta;
}

export interface Citation {
  path: string;
  startLine: number;
  endLine: number;
  url: string;
}

export interface IndexInfo {
  status: 'partial' | 'background-indexing' | 'complete' | 'failed';
  ref: string;
  commitSha: string;
  fullCoverage: boolean;
  retrieval: 'lexical' | 'hybrid';
  indexedFiles: number;
  eligibleFiles: number;
  treeTruncated: boolean;
}

export type ChatMessageStatus = 'streaming' | 'complete' | 'stopped' | 'interrupted' | 'error';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Assistant messages only. Undefined for messages saved by older versions. */
  status?: ChatMessageStatus;
  citations?: Citation[];
  index?: IndexInfo;
  error?: { code: string; message: string };
  finishReason?: string | null;
}

export function repoKeyOf(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`;
}

interface Store {
  isOpen: boolean;
  view: PanelView;
  /** Where to return after the consent or settings screen. */
  previousView: PanelView;
  pageContext: PageContext | null;
  activeAction: CardType | null;
  pendingIssueNumber: number | null;

  consentAccepted: boolean;
  consentLoaded: boolean;
  /** An action the user chose before accepting the data notice; run after accepting. */
  pendingConsentAction: CardType | 'chat' | null;

  repoResult: ExplainRepoResult | null;
  repoResultTarget: string | null;
  repoLoading: boolean;
  repoError: UiError | null;

  fileResult: ExplainFileResult | null;
  fileResultTarget: string | null;
  fileQuickResult: ExplainFileQuickResult | null;
  fileLoading: boolean;
  fileError: UiError | null;
  fileStage: FileDetectionStage | null;
  // performance.now() timestamp of the navigation that triggered the current file
  // detection, for dev timing logs.
  fileNavStartedAt: number | null;

  issueResult: AnalysisResult | null;
  issueResultTarget: string | null;
  issueLoading: boolean;
  issueError: UiError | null;

  goodFirstIssuesResult: GoodFirstIssueItem[] | null;
  goodFirstIssuesResultTarget: string | null;
  goodFirstIssuesLoading: boolean;
  goodFirstIssuesError: UiError | null;

  /** Repository the in-memory conversation belongs to. */
  chatConversationKey: string | null;
  chatHydrated: boolean;
  chatMessages: ChatMessage[];
  chatInput: string;
  chatStreaming: boolean;
  chatStorageWarning: string | null;

  setOpen: (open: boolean) => void;
  setView: (view: PanelView) => void;
  setPageContext: (ctx: PageContext | null) => void;
  setActiveAction: (action: CardType | null) => void;
  setPendingIssueNumber: (n: number | null) => void;

  setFileStage: (s: FileDetectionStage | null) => void;
  setFileNavStartedAt: (t: number | null) => void;
  setChatInput: (input: string) => void;

  /** Drops every result/error/loading flag (repository changed). */
  resetResults: () => void;
  /** Drops the file explanation (different file or ref in the same repository). */
  resetFileResult: () => void;
  /** Drops the issue analysis (different issue in the same repository). */
  resetIssueResult: () => void;

  goToQuickActions: () => void;
}

const emptyResults = {
  activeAction: null,
  pendingIssueNumber: null,
  repoResult: null,
  repoResultTarget: null,
  repoLoading: false,
  repoError: null,
  fileResult: null,
  fileResultTarget: null,
  fileQuickResult: null,
  fileLoading: false,
  fileError: null,
  fileStage: null,
  fileNavStartedAt: null,
  issueResult: null,
  issueResultTarget: null,
  issueLoading: false,
  issueError: null,
  goodFirstIssuesResult: null,
  goodFirstIssuesResultTarget: null,
  goodFirstIssuesLoading: false,
  goodFirstIssuesError: null,
} as const;

export const useStore = create<Store>((set) => ({
  isOpen: false,
  view: 'empty',
  previousView: 'home',
  pageContext: null,

  consentAccepted: false,
  consentLoaded: false,
  pendingConsentAction: null,

  ...emptyResults,

  chatConversationKey: null,
  chatHydrated: false,
  chatMessages: [],
  chatInput: '',
  chatStreaming: false,
  chatStorageWarning: null,

  setOpen: (open) => set({ isOpen: open }),
  setView: (view) => set({ view }),
  setPageContext: (pageContext) => set({ pageContext }),
  setActiveAction: (activeAction) => set({ activeAction }),
  setPendingIssueNumber: (pendingIssueNumber) => set({ pendingIssueNumber }),

  setFileStage: (fileStage) => set({ fileStage }),
  setFileNavStartedAt: (fileNavStartedAt) => set({ fileNavStartedAt }),
  setChatInput: (chatInput) => set({ chatInput }),

  resetResults: () => set({ ...emptyResults }),
  resetFileResult: () => set({ fileResult: null, fileResultTarget: null, fileQuickResult: null, fileError: null, fileLoading: false }),
  resetIssueResult: () => set({ issueResult: null, issueResultTarget: null, issueError: null, issueLoading: false }),

  goToQuickActions: () => set({ view: 'home', activeAction: null }),
}));
