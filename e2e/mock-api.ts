import http from 'node:http';

export interface RecordedRequest {
  path: string;
  body: any;
}

type Handler = (body: any, res: http.ServerResponse) => void | Promise<void>;

const SHA = 'abc1234def5678abc1234def5678abc1234def56';
export const MOCK_SHA = SHA;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

export const defaults: Record<string, Handler> = {
  '/v1/explain-repo': (body, res) =>
    json(res, 200, {
      purpose: `Explains ${body.repoName}`,
      techStack: ['TypeScript'],
      folderStructure: [{ path: 'src', description: 'Source' }],
      architecture: [{ title: 'Core', description: 'Core logic' }],
      keyEntrypoints: [{ path: 'src/auth.ts', label: 'Auth', loc: 3, url: `https://github.com/${body.repoOwner}/${body.repoName}/blob/${SHA}/src/auth.ts` }],
      dataFlow: 'Requests flow through src/auth.ts.',
      authPersistence: '',
      howToRun: ['npm install'],
      beginnerStart: 'Start with src/auth.ts',
      goodFirstIssues: [],
      goodFirstIssuesError: null,
      meta: { ref: 'main', commitSha: SHA, filesInTree: 3, filesShownToModel: 3, treeTruncated: false, readmeTruncated: false, hasReadme: true },
    }),
  '/v1/explain-file/quick': (body, res) => json(res, 200, { purpose: `Quick: ${body.filePath}@${body.ref}`, summary: 'quick' }),
  '/v1/explain-file': (body, res) =>
    json(res, 200, {
      purpose: `Explains ${body.repoName}:${body.filePath}@${body.ref}`,
      summary: 'A file.',
      mainComponents: ['login — logs in'],
      relatedFiles: [{ path: 'src/session.ts', verified: true }, { path: 'src/made-up.ts', verified: false }],
      meta: { ref: body.ref, commitSha: SHA, path: body.filePath, lines: 3, totalChars: 40, analyzedChars: 40, truncated: false },
    }),
  '/v1/analyze': (body, res) =>
    json(res, 200, {
      whatItAsks: [`Fix issue ${body.issueNumber}`],
      relevantFiles: [{ path: 'src/auth.ts', reason: 'auth', verified: true }],
      implementationSteps: ['Change it'],
      difficulty: 'beginner',
      timeEstimate: '1-2 hours',
      meta: { issueNumber: body.issueNumber, title: 't', state: 'open', updatedAt: '', commentsTotal: 0, commentsIncluded: 0, commitSha: SHA, ref: 'main' },
    }),
  '/v1/good-first-issues': (_body, res) => json(res, 200, { goodFirstIssues: [] }),
  '/v1/ask-repo': async (body, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' });
    const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    send({ type: 'status', indexing: 'complete', index: { status: 'complete', ref: 'main', commitSha: SHA, fullCoverage: true, retrieval: 'lexical', coverage: { indexedFiles: 3, eligibleFiles: 3 } } });
    send({ type: 'citations', citations: [{ path: 'src/auth.ts', startLine: 1, endLine: 3, url: `https://github.com/owner/repo/blob/${SHA}/src/auth.ts#L1-L3` }] });
    for (const piece of ['Login is in ', '`src/auth.ts` [1].', `\n\nYou asked: ${body.question}`]) {
      send({ type: 'chunk', content: piece });
      await new Promise((r) => setTimeout(r, 30));
    }
    send({ type: 'done', finishReason: 'stop' });
    res.end();
  },
};

export class MockApi {
  readonly requests: RecordedRequest[] = [];
  private overrides = new Map<string, Handler>();
  private server: http.Server;

  constructor(readonly port: number) {
    this.server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'content-type, accept',
          'Access-Control-Allow-Private-Network': 'true',
        });
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const path = (req.url ?? '').split('?')[0];
        const body = raw ? JSON.parse(raw) : {};
        this.requests.push({ path, body });
        const handler = this.overrides.get(path) ?? defaults[path];
        if (!handler) return json(res, 404, { error: 'not found', code: 'INVALID_REQUEST' });
        try {
          await handler(body, res);
        } catch {
          if (!res.headersSent) json(res, 500, { error: 'mock failure', code: 'INTERNAL' });
        }
      });
    });
  }

  on(path: string, handler: Handler): void {
    this.overrides.set(path, handler);
  }

  reset(): void {
    this.overrides.clear();
    this.requests.length = 0;
  }

  requestsTo(path: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === path);
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, () => resolve()));
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
