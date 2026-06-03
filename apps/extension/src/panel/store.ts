import { create } from 'zustand';

export type PanelView = 'home' | 'result' | 'chat' | 'empty';
export type PageKind = 'repo' | 'file' | 'issue';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';
export type CardType = 'repo' | 'file' | 'issue' | 'good-first-issues';

// Pipeline stages for turning a detected file route into ready-to-analyze content.
// 'streaming' is reserved for a future SSE-based explain-file call; the current
// backend responds in one shot, so 'request_started' goes straight to 'complete'.
export type FileDetectionStage =
  | 'file_detected'
  | 'waiting_for_content'
  | 'content_extracted'
  | 'request_started'
  | 'streaming'
  | 'complete';

export interface PageContext {
  repoOwner: string;
  repoName: string;
  page: PageKind;
  filePath?: string;
  fileRef?: string;
  fileContent?: string;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueComments?: string;
}

export interface RelevantFile {
  path: string;
  reason: string;
}

export interface ArchitectureItem {
  title: string;
  description: string;
}

export interface EntrypointItem {
  path: string;
  label: string;
  loc: number;
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
  goodFirstIssues: GoodFirstIssueItem[];
}

export interface ExplainFileQuickResult {
  purpose: string;
  summary: string;
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
  relatedFiles: string[];
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
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function repoKeyOf(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`;
}

interface Store {
  isOpen: boolean;
  view: PanelView;
  pageContext: PageContext | null;
  activeAction: CardType | null;
  pendingIssueNumber: number | null;

  repoResult: ExplainRepoResult | null;
  repoLoading: boolean;
  repoError: string | null;

  fileResult: ExplainFileResult | null;
  fileQuickResult: ExplainFileQuickResult | null;
  fileLoading: boolean;
  fileError: string | null;
  fileStage: FileDetectionStage | null;
  // performance.now() timestamp of the navigation that triggered the current file
  // detection — lets later stages (e.g. the explain-file request) log a timing delta
  // relative to when the user actually opened the file, not when they were called.
  fileNavStartedAt: number | null;

  issueResult: AnalysisResult | null;
  issueLoading: boolean;
  issueError: string | null;

  goodFirstIssuesResult: GoodFirstIssueItem[] | null;
  goodFirstIssuesLoading: boolean;
  goodFirstIssuesError: string | null;

  chatMessages: ChatMessage[];
  chatInput: string;
  chatStreaming: boolean;
  chatContextNote: string | null;

  setOpen: (open: boolean) => void;
  setView: (view: PanelView) => void;
  setPageContext: (ctx: PageContext | null) => void;
  setActiveAction: (action: CardType | null) => void;
  setPendingIssueNumber: (n: number | null) => void;

  setRepoResult: (r: ExplainRepoResult | null) => void;
  setRepoLoading: (b: boolean) => void;
  setRepoError: (e: string | null) => void;

  setFileResult: (r: ExplainFileResult | null) => void;
  setFileQuickResult: (r: ExplainFileQuickResult | null) => void;
  setFileLoading: (b: boolean) => void;
  setFileError: (e: string | null) => void;
  setFileStage: (s: FileDetectionStage | null) => void;
  setFileNavStartedAt: (t: number | null) => void;

  setIssueResult: (r: AnalysisResult | null) => void;
  setIssueLoading: (b: boolean) => void;
  setIssueError: (e: string | null) => void;

  setGoodFirstIssuesResult: (r: GoodFirstIssueItem[] | null) => void;
  setGoodFirstIssuesLoading: (b: boolean) => void;
  setGoodFirstIssuesError: (e: string | null) => void;

  resetResults: () => void;

  addChatMessage: (msg: ChatMessage) => void;
  appendToLastChatMessage: (content: string) => void;
  setChatMessages: (messages: ChatMessage[]) => void;
  setChatInput: (input: string) => void;
  setChatStreaming: (streaming: boolean) => void;
  setChatContextNote: (note: string | null) => void;
  resetChat: () => void;

  goToQuickActions: () => void;
}

export const useStore = create<Store>((set) => ({
  isOpen: false,
  view: 'empty',
  pageContext: null,
  activeAction: null,
  pendingIssueNumber: null,

  repoResult: null,
  repoLoading: false,
  repoError: null,

  fileResult: null,
  fileQuickResult: null,
  fileLoading: false,
  fileError: null,
  fileStage: null,
  fileNavStartedAt: null,

  issueResult: null,
  issueLoading: false,
  issueError: null,

  goodFirstIssuesResult: null,
  goodFirstIssuesLoading: false,
  goodFirstIssuesError: null,

  chatMessages: [],
  chatInput: '',
  chatStreaming: false,
  chatContextNote: null,

  setOpen: (open) => set({ isOpen: open }),
  setView: (view) => set({ view }),
  setPageContext: (pageContext) => set({ pageContext }),
  setActiveAction: (activeAction) => set({ activeAction }),
  setPendingIssueNumber: (pendingIssueNumber) => set({ pendingIssueNumber }),

  setRepoResult: (repoResult) => set({ repoResult }),
  setRepoLoading: (repoLoading) => set({ repoLoading }),
  setRepoError: (repoError) => set({ repoError }),

  setFileResult: (fileResult) => set({ fileResult }),
  setFileQuickResult: (fileQuickResult) => set({ fileQuickResult }),
  setFileLoading: (fileLoading) => set({ fileLoading }),
  setFileError: (fileError) => set({ fileError }),
  setFileStage: (fileStage) => set({ fileStage }),
  setFileNavStartedAt: (fileNavStartedAt) => set({ fileNavStartedAt }),

  setIssueResult: (issueResult) => set({ issueResult }),
  setIssueLoading: (issueLoading) => set({ issueLoading }),
  setIssueError: (issueError) => set({ issueError }),

  setGoodFirstIssuesResult: (goodFirstIssuesResult) => set({ goodFirstIssuesResult }),
  setGoodFirstIssuesLoading: (goodFirstIssuesLoading) => set({ goodFirstIssuesLoading }),
  setGoodFirstIssuesError: (goodFirstIssuesError) => set({ goodFirstIssuesError }),

  resetResults: () =>
    set({
      activeAction: null,
      pendingIssueNumber: null,
      repoResult: null,
      repoLoading: false,
      repoError: null,
      fileResult: null,
      fileQuickResult: null,
      fileLoading: false,
      fileError: null,
      fileStage: null,
      fileNavStartedAt: null,
      issueResult: null,
      issueLoading: false,
      issueError: null,
      goodFirstIssuesResult: null,
      goodFirstIssuesLoading: false,
      goodFirstIssuesError: null,
    }),

  addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),

  appendToLastChatMessage: (content) =>
    set((s) => {
      const chatMessages = [...s.chatMessages];
      const last = chatMessages[chatMessages.length - 1];
      if (last?.role === 'assistant') {
        chatMessages[chatMessages.length - 1] = { ...last, content: last.content + content };
      }
      return { chatMessages };
    }),

  setChatMessages: (chatMessages) => set({ chatMessages }),
  setChatInput: (chatInput) => set({ chatInput }),
  setChatStreaming: (chatStreaming) => set({ chatStreaming }),
  setChatContextNote: (chatContextNote) => set({ chatContextNote }),

  resetChat: () => set({ chatMessages: [], chatInput: '', chatStreaming: false, chatContextNote: null }),

  goToQuickActions: () => set({ view: 'home', activeAction: null }),
}));
