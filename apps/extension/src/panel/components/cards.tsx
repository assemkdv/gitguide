import React from 'react';
import { AnalysisResult, Difficulty, ExplainFileQuickResult, ExplainFileResult, ExplainRepoResult, GoodFirstIssueItem } from '../store';
import { Collapsible, CopyButton, sectionLabel, SC as C } from './shared';
import type { CheckedPath } from '../store';

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : '';
}

/** Small provenance line: which ref/commit an explanation was produced from. */
export function SourceNote({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: '10px 0 0', fontSize: 10.5, color: C.mutedDim, lineHeight: 1.5 }}>{children}</p>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="note"
      style={{ margin: '0 0 10px', padding: '7px 10px', fontSize: 11.5, lineHeight: 1.5, color: '#d29922', background: 'rgba(210,153,34,0.08)', border: '1px solid rgba(210,153,34,0.25)', borderRadius: 7 }}
    >
      {children}
    </div>
  );
}

function VerifiedTag({ verified }: { verified: boolean }) {
  return (
    <span
      title={verified ? 'This file exists in the repository at the analyzed commit.' : 'Suggested by the AI; GitGuide could not find this exact file in the repository.'}
      style={{ fontSize: 9.5, fontWeight: 600, padding: '0 5px', borderRadius: 99, marginLeft: 6, whiteSpace: 'nowrap', color: verified ? '#3fb950' : '#d29922', border: `1px solid ${verified ? 'rgba(63,185,80,0.35)' : 'rgba(210,153,34,0.35)'}` }}
    >
      {verified ? 'exists' : 'suggestion'}
    </span>
  );
}

const pathLabel = (f: CheckedPath) => `${f.path}${f.verified ? '' : ' (unverified suggestion)'}`;

const DIFFICULTY_CONFIG: Record<Difficulty, { bg: string; color: string; border: string; label: string }> = {
  beginner: { bg: 'rgba(63,185,80,0.1)', color: '#3fb950', border: 'rgba(63,185,80,0.25)', label: 'Beginner' },
  intermediate: { bg: 'rgba(210,153,34,0.1)', color: '#d29922', border: 'rgba(210,153,34,0.25)', label: 'Intermediate' },
  advanced: { bg: 'rgba(248,81,73,0.1)', color: '#f85149', border: 'rgba(248,81,73,0.25)', label: 'Advanced' },
};

export function BookIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 3 C4 2 6 2 8 3.2 C10 2 12 2 14 3 V13 C12 12 10 12 8 13.2 C6 12 4 12 2 13 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 3.2 V13.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M5 4 L1.5 8 L5 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11 4 L14.5 8 L11 12" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function MessageIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M2 3 H14 V11 H6 L3 13.5 V11 H2 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.1 V10.9 M4 6 C4 9 8 9 8 9 C10.5 9 12 9.8 12 11" stroke="currentColor" strokeWidth="1.3" fill="none" />
    </svg>
  );
}

export function LayersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2 L14 5 L8 8 L2 5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M2 8.5 L8 11.5 L14 8.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M2 11.5 L8 14.5 L14 11.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 3.5 h4 l1.5 2 h7.5 v7 h-13 z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M4 2.5 L13.5 8 L4 13.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function FlagIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M3 2 V14 M3 2.5 H12 L9.5 5.5 L12 8.5 H3" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5 L15 14 H1 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.5 V9.5 M8 11.5 V11.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg width="14" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0, marginTop: 2 }}>
      <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688Z" fill="#484f58" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <path d="M3 8H13M13 8L9 4M13 8L9 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GoodFirstIssueCard({ issue, onSelect }: { issue: GoodFirstIssueItem; onSelect?: (issue: GoodFirstIssueItem) => void }) {
  const [hovered, setHovered] = React.useState(false);
  const accentColor = issue.category === 'good first issue' ? '#3fb950' : '#d29922';
  const accentBorder = issue.category === 'good first issue' ? 'rgba(63,185,80,0.35)' : 'rgba(210,153,34,0.35)';

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: '1px 7px',
            borderRadius: 99,
            color: accentColor,
            background: issue.category === 'good first issue' ? 'rgba(63,185,80,0.1)' : 'rgba(210,153,34,0.1)',
          }}
        >
          {issue.category}
        </span>
        {onSelect && (
          <span style={{ color: C.mutedDim, opacity: hovered ? 1 : 0.5, transition: 'opacity 0.15s', flexShrink: 0 }}>
            <ArrowRightIcon />
          </span>
        )}
      </div>
      <p style={{ margin: '6px 0 3px', fontSize: 12.5, color: C.text, fontWeight: 500, lineHeight: 1.4 }}>{issue.title}</p>
      <span style={{ fontSize: 11, color: C.mutedDim }}>
        #{issue.number} · {issue.comments} comment{issue.comments === 1 ? '' : 's'}
      </span>
      {onSelect && (
        <p style={{ margin: '5px 0 0', fontSize: 10.5, color: C.accent, fontWeight: 500 }}>Click to open and analyze →</p>
      )}
    </>
  );

  if (!onSelect) {
    return (
      <div style={{ border: `1px solid ${accentBorder}`, borderRadius: 8, padding: '8px 10px' }}>{content}</div>
    );
  }

  return (
    <button
      onClick={() => onSelect(issue)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'inherit',
        border: `1px solid ${hovered ? C.accent : accentBorder}`,
        borderRadius: 8,
        padding: '8px 10px',
        background: hovered ? C.bgTer : 'transparent',
        transform: hovered ? 'translateY(-1px)' : 'none',
        boxShadow: hovered ? '0 3px 10px rgba(0,0,0,0.28)' : 'none',
        transition: 'transform 0.15s, box-shadow 0.15s, border-color 0.15s, background 0.15s',
      }}
    >
      {content}
    </button>
  );
}

export function GoodFirstIssueList({
  issues,
  onSelect,
}: {
  issues: GoodFirstIssueItem[];
  onSelect?: (issue: GoodFirstIssueItem) => void;
}) {
  if (issues.length === 0) {
    return <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>No open good-first-issue or help-wanted issues found.</p>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {issues.map((issue) => (
        <GoodFirstIssueCard key={issue.number} issue={issue} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function formatRepoResultAsText(r: ExplainRepoResult): string {
  const lines = [
    r.purpose,
    '',
    `Tech stack: ${r.techStack.join(', ')}`,
    '',
    'Folder structure:',
    ...r.folderStructure.map((f) => `- ${f.path} — ${f.description}`),
    '',
    'Architecture:',
    ...r.architecture.map((a, i) => `${i + 1}. ${a.title} — ${a.description}`),
    '',
    'Key entrypoints:',
    ...r.keyEntrypoints.map((e) => `- ${e.path} (${e.label}${e.loc != null ? `, ${e.loc} loc` : ''})`),
    '',
    `Data flow: ${r.dataFlow}`,
  ];
  if (r.authPersistence) lines.push('', `Auth/persistence: ${r.authPersistence}`);
  lines.push('', 'How to run:', ...r.howToRun.map((s, i) => `${i + 1}. ${s}`));
  lines.push('', `Where to start: ${r.beginnerStart}`);
  if (r.goodFirstIssues) lines.push('', 'Good first issues:', ...r.goodFirstIssues.map((i) => `- #${i.number} ${i.title} [${i.category}]`));
  if (r.meta) lines.push('', `Source: ${r.meta.ref} @ ${shortSha(r.meta.commitSha)}`);
  return lines.join('\n');
}

export function formatFileResultAsText(r: ExplainFileResult): string {
  const lines = [
    r.purpose,
    '',
    r.summary,
    '',
    'Main components:',
    ...r.mainComponents.map((c) => `- ${c}`),
    '',
    `Inputs/outputs: ${r.inputsOutputs}`,
    '',
    'Dependencies:',
    ...(r.dependencies.length ? r.dependencies.map((d) => `- ${d}`) : ['- none']),
    '',
    `Used by: ${r.usedBy}`,
    `Connections: ${r.connections}`,
    '',
    `Important logic: ${r.importantLogic}`,
  ];
  if (r.edgeCases) lines.push('', `Edge cases: ${r.edgeCases}`);
  lines.push('', `For contributors: ${r.contributorNotes}`);
  if (r.relatedFiles.length) lines.push('', 'Related files:', ...r.relatedFiles.map((f) => `- ${pathLabel(f)}`));
  if (r.meta) lines.push('', `Source: ${r.meta.path} at ${r.meta.ref} @ ${shortSha(r.meta.commitSha)}${r.meta.truncated ? ` (first ${r.meta.analyzedChars} of ${r.meta.totalChars} characters analyzed)` : ''}`);
  return lines.join('\n');
}

export function formatIssueResultAsText(a: AnalysisResult): string {
  const lines = [
    "What it's asking:",
    ...a.whatItAsks.map((s) => `- ${s}`),
    '',
    `Why it matters: ${a.whyItMatters}`,
    '',
    `Current behavior: ${a.currentBehavior}`,
    `Expected behavior: ${a.expectedBehavior}`,
  ];
  if (a.discussionContext) lines.push('', `Discussion context: ${a.discussionContext}`);
  lines.push('', 'Relevant files:', ...a.relevantFiles.map((f) => `- ${pathLabel(f)} — ${f.reason}`));
  lines.push('', 'Implementation steps:', ...a.implementationSteps.map((s, i) => `${i + 1}. ${s}`));
  lines.push('', `Risks: ${a.risks}`, `Testing: ${a.testingConsiderations}`);
  lines.push('', `Difficulty: ${a.difficulty} · ${a.timeEstimate}`);
  return lines.join('\n');
}

export function RepoCard({
  data,
  onSelectIssue,
}: {
  data: ExplainRepoResult;
  onSelectIssue?: (issue: GoodFirstIssueItem) => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <p style={{ margin: '0 0 8px', fontSize: 13, color: C.textSub, lineHeight: 1.6 }}>{data.purpose}</p>
        <CopyButton getText={() => formatRepoResultAsText(data)} />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 4 }}>
        {data.techStack.map((t, i) => (
          <span
            key={i}
            style={{
              fontSize: 10.5,
              color: C.muted,
              background: C.bgTer,
              border: `1px solid ${C.borderMuted}`,
              borderRadius: 99,
              padding: '2px 8px',
            }}
          >
            {t}
          </span>
        ))}
      </div>

      <Collapsible title="Folder structure" icon={<FolderIcon />} defaultOpen={false}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.folderStructure.map((f, i) => (
            <div key={i} style={{ fontSize: 12, lineHeight: 1.5 }}>
              <span style={{ fontFamily: 'ui-monospace, monospace', color: C.accent }}>{f.path}/</span>{' '}
              <span style={{ color: C.mutedDim }}>{f.description}</span>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Architecture" icon={<LayersIcon />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.architecture.map((item, i) => (
            <div key={i} style={{ display: 'flex', gap: 10 }}>
              <span style={{ fontSize: 11, color: C.accent, fontFamily: 'ui-monospace, monospace', flexShrink: 0, marginTop: 1 }}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
                <strong style={{ color: C.text, fontWeight: 600 }}>{item.title}</strong> — {item.description}
              </span>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Key entrypoints" icon={<CodeIcon />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {data.keyEntrypoints.length === 0 && (
            <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>No entrypoints could be confirmed from the file tree.</p>
          )}
          {data.keyEntrypoints.map((e, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 0' }}>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noopener noreferrer" className="gg-link" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, wordBreak: 'break-all' }}>
                  {e.path}
                </a>
              ) : (
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: C.muted, wordBreak: 'break-all' }}>{e.path}</span>
              )}
              <span style={{ fontSize: 10.5, color: C.mutedDim, flexShrink: 0, whiteSpace: 'nowrap' }}>
                {e.label}
                {e.loc != null ? ` · ${e.loc} loc` : ''}
              </span>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Data flow & persistence" icon={<BranchIcon />} defaultOpen={false}>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.dataFlow}</p>
        {data.authPersistence && (
          <p style={{ margin: '8px 0 0', fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.authPersistence}</p>
        )}
      </Collapsible>

      <Collapsible title="How to run" icon={<PlayIcon />} defaultOpen={false}>
        {data.howToRun.length === 0 && (
          <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>The README and manifests don&apos;t show how to run this project.</p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data.howToRun.map((step, i) => (
            <div key={i} style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
              {i + 1}. {step}
            </div>
          ))}
        </div>
      </Collapsible>

      <div style={{ marginTop: 10, padding: '9px 11px', background: C.bgTer, borderRadius: 8, display: 'flex', gap: 8 }}>
        <span style={{ color: C.accent, flexShrink: 0 }}>
          <FlagIcon />
        </span>
        <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.beginnerStart}</span>
      </div>

      <Collapsible title="Good first issues" icon={<BranchIcon />}>
        {data.goodFirstIssues ? (
          <GoodFirstIssueList issues={data.goodFirstIssues} onSelect={onSelectIssue} />
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>
            {data.goodFirstIssuesError === 'GITHUB_RATE_LIMITED'
              ? 'GitHub is rate-limiting GitGuide, so open issues could not be loaded right now.'
              : 'Open issues could not be loaded right now.'}
          </p>
        )}
      </Collapsible>

      {data.meta && (
        <SourceNote>
          Based on {data.meta.ref} @ {shortSha(data.meta.commitSha)} · README{data.meta.hasReadme ? (data.meta.readmeTruncated ? ' (beginning only)' : '') : ' not found'} ·{' '}
          {data.meta.filesShownToModel < data.meta.filesInTree
            ? `${data.meta.filesShownToModel} of ${data.meta.filesInTree} file paths`
            : `all ${data.meta.filesInTree} file paths`}
          {data.meta.treeTruncated ? ' (GitHub truncated the file list)' : ''}. File contents were not read.
        </SourceNote>
      )}
    </div>
  );
}

export function QuickFilePreview({ data }: { data: ExplainFileQuickResult }) {
  return (
    <div>
      <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: C.text, lineHeight: 1.5 }}>{data.purpose}</p>
      <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.summary}</p>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          marginTop: 14,
          padding: '7px 10px',
          background: C.bgTer,
          border: `1px solid ${C.borderMuted}`,
          borderRadius: 7,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: '#3fb950',
            flexShrink: 0,
            animation: 'pulse 1.2s ease-in-out infinite',
          }}
        />
        <span style={{ fontSize: 11, color: C.mutedDim }}>
          <span style={{ color: C.muted }}>Quick explanation ready</span> · Deep analysis continuing…
        </span>
      </div>
    </div>
  );
}

export function FileCard({ data }: { data: ExplainFileResult }) {
  return (
    <div>
      {data.meta?.truncated && (
        <Notice>
          Only the first {data.meta.analyzedChars.toLocaleString()} of {data.meta.totalChars.toLocaleString()} characters of this file were analyzed.
          Parts of the file after that are not covered.
        </Notice>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div>
          <p style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 600, color: C.text, lineHeight: 1.5 }}>{data.purpose}</p>
          <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.summary}</p>
        </div>
        <CopyButton getText={() => formatFileResultAsText(data)} />
      </div>

      <Collapsible title="Main components" icon={<CodeIcon />}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.mainComponents.map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: C.mutedDim, fontSize: 12, marginTop: 2 }}>•</span>
              <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{c}</span>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Inputs & outputs" icon={<BranchIcon />} defaultOpen={false}>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.inputsOutputs}</p>
      </Collapsible>

      <Collapsible title="Dependencies" icon={<LayersIcon />} defaultOpen={false}>
        {data.dependencies.length === 0 ? (
          <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>No notable external dependencies.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {data.dependencies.map((d, i) => (
              <div key={i} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: C.muted, padding: '4px 0' }}>
                {d}
              </div>
            ))}
          </div>
        )}
      </Collapsible>

      <Collapsible title="Used by & connections" icon={<BranchIcon />} defaultOpen={false}>
        <p style={{ margin: '0 0 6px', fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.usedBy}</p>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.connections}</p>
      </Collapsible>

      <Collapsible title="Important logic" icon={<AlertIcon />}>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.importantLogic}</p>
      </Collapsible>

      {data.edgeCases && (
        <Collapsible title="Edge cases" icon={<AlertIcon />} defaultOpen={false}>
          <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.edgeCases}</p>
        </Collapsible>
      )}

      <div style={{ marginTop: 10, padding: '9px 11px', background: C.bgTer, borderRadius: 8, display: 'flex', gap: 8 }}>
        <span style={{ color: C.accent, flexShrink: 0 }}>
          <FlagIcon />
        </span>
        <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.contributorNotes}</span>
      </div>

      {data.relatedFiles.length > 0 && (
        <Collapsible title="Related files" icon={<FileGlyphIcon />} defaultOpen={false}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {data.relatedFiles.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '4px 0' }}>
                <FileGlyph />
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11.5, color: C.muted, wordBreak: 'break-all' }}>
                  {f.path}
                  <VerifiedTag verified={f.verified} />
                </span>
              </div>
            ))}
          </div>
        </Collapsible>
      )}

      {data.meta && (
        <SourceNote>
          Based on {data.meta.ref} @ {shortSha(data.meta.commitSha)} · {data.meta.lines.toLocaleString()} lines. Statements about how other files use this one
          are inferred, not verified.
        </SourceNote>
      )}
    </div>
  );
}

function FileGlyphIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M9 1 H3.5 V15 H12.5 V4.5 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 1 V4.5 H12.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function IssueCard({ data }: { data: AnalysisResult }) {
  const diff = DIFFICULTY_CONFIG[data.difficulty] ?? DIFFICULTY_CONFIG.intermediate;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 99,
              fontSize: 11,
              fontWeight: 500,
              background: diff.bg,
              color: diff.color,
              border: `1px solid ${diff.border}`,
            }}
          >
            {diff.label}
          </span>
          <span style={{ color: '#30363d' }}>·</span>
          <span style={{ fontSize: 11, color: C.mutedDim }}>{data.timeEstimate}</span>
        </div>
        <CopyButton getText={() => formatIssueResultAsText(data)} />
      </div>

      <p style={sectionLabel}>What it's asking</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6, marginBottom: 12 }}>
        {data.whatItAsks.map((bullet, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span style={{ color: C.mutedDim, fontSize: 12, marginTop: 2, flexShrink: 0 }}>•</span>
            <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{bullet}</span>
          </div>
        ))}
      </div>

      <Collapsible title="Why it matters" icon={<FlagIcon />} defaultOpen={false}>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.whyItMatters}</p>
      </Collapsible>

      <Collapsible title="Current vs. expected behavior" icon={<AlertIcon />}>
        <p style={{ margin: '0 0 6px', fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
          <strong style={{ color: C.text, fontWeight: 600 }}>Now:</strong> {data.currentBehavior}
        </p>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
          <strong style={{ color: C.text, fontWeight: 600 }}>Expected:</strong> {data.expectedBehavior}
        </p>
      </Collapsible>

      {data.discussionContext && (
        <Collapsible title="Discussion context" icon={<MessageIcon />} defaultOpen={false}>
          <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{data.discussionContext}</p>
        </Collapsible>
      )}

      <Collapsible title="Possibly relevant files" icon={<CodeIcon />} defaultOpen={false}>
        <p style={{ margin: '0 0 8px', fontSize: 11, color: C.mutedDim, lineHeight: 1.5 }}>
          Suggestions based on the issue text and file names; GitGuide did not read these files.
        </p>
        {data.relevantFiles.length === 0 && <p style={{ margin: 0, fontSize: 12, color: C.mutedDim }}>No files could be matched to this issue.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.relevantFiles.map((file, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <FileGlyph />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, color: C.muted, wordBreak: 'break-all', marginBottom: 2 }}>
                  {file.path}
                  <VerifiedTag verified={file.verified} />
                </div>
                <div style={{ fontSize: 11, color: C.mutedDim, lineHeight: 1.5 }}>{file.reason}</div>
              </div>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Implementation steps" icon={<LayersIcon />}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.implementationSteps.map((step, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
                padding: '7px 0',
                borderBottom: i < data.implementationSteps.length - 1 ? `1px solid ${C.borderMuted}` : 'none',
              }}
            >
              <span
                style={{
                  flexShrink: 0,
                  width: 17,
                  height: 17,
                  borderRadius: '50%',
                  background: C.accentDim,
                  border: `1px solid ${C.accentBorder}`,
                  color: C.accent,
                  fontSize: 9,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginTop: 1,
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {i + 1}
              </span>
              <span style={{ fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>{step}</span>
            </div>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="Risks & testing" icon={<AlertIcon />} defaultOpen={false}>
        <p style={{ margin: '0 0 6px', fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
          <strong style={{ color: C.text, fontWeight: 600 }}>Risks:</strong> {data.risks || 'Not described.'}
        </p>
        <p style={{ margin: 0, fontSize: 12.5, color: C.textSub, lineHeight: 1.6 }}>
          <strong style={{ color: C.text, fontWeight: 600 }}>Testing:</strong> {data.testingConsiderations || 'Not described.'}
        </p>
      </Collapsible>

      {data.meta && (
        <SourceNote>
          Based on issue #{data.meta.issueNumber} ({data.meta.state}) with {data.meta.commentsIncluded} of {data.meta.commentsTotal} comments, read from GitHub. File
          suggestions were checked against {data.meta.ref} @ {shortSha(data.meta.commitSha)}.
        </SourceNote>
      )}
    </div>
  );
}
