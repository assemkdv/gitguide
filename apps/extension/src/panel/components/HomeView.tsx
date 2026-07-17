import { useState } from 'react';
import { useStore, CardType, PageContext } from '../store';
import { runExplainRepo, runExplainFile, runSummarizeIssue, runGoodFirstIssues } from '../runActions';
import { BookIcon, CodeIcon, MessageIcon, BranchIcon } from './cards';
import { sectionLabel, SC as C } from './shared';

interface ActionSpec {
  key: CardType;
  label: string;
  sub: string;
  icon: () => JSX.Element;
  run: (ctx: PageContext) => void;
}

const ACTIONS: ActionSpec[] = [
  { key: 'repo', label: 'Explain Repository', sub: 'High-level overview', icon: BookIcon, run: runExplainRepo },
  { key: 'file', label: 'Explain File', sub: 'Current file breakdown', icon: CodeIcon, run: runExplainFile },
  { key: 'issue', label: 'Summarize Issue', sub: 'TL;DR + context', icon: MessageIcon, run: runSummarizeIssue },
  { key: 'good-first-issues', label: 'Find Good First Issue', sub: 'Where to contribute', icon: BranchIcon, run: runGoodFirstIssues },
];

function ActionTile({ action, onClick }: { action: ActionSpec; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const Icon = action.icon;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        textAlign: 'left',
        background: C.bgSec,
        border: `1px solid ${hovered ? C.accent : C.borderMuted}`,
        borderRadius: 9,
        padding: '9px 10px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex',
        flexDirection: 'column',
        gap: 7,
        transition: 'border-color 0.12s',
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          background: C.bgTer,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: C.muted,
        }}
      >
        <Icon />
      </span>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>{action.label}</div>
        <div style={{ fontSize: 10.5, color: C.mutedDim, lineHeight: 1.4, marginTop: 1 }}>{action.sub}</div>
      </div>
    </button>
  );
}

function AskGitGuideIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 3 H14 V11 H6 L3 13.5 V11 H2 Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="5.5" cy="7" r="0.9" fill="currentColor" />
      <circle cx="8" cy="7" r="0.9" fill="currentColor" />
      <circle cx="10.5" cy="7" r="0.9" fill="currentColor" />
    </svg>
  );
}

function AskRepoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.7 10.7 L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function HomeView() {
  const { pageContext, setView, chatMessages, askRepoMessages } = useStore();

  if (!pageContext) return null;

  const handleActionClick = (action: ActionSpec) => action.run(pageContext);
  const hasExistingChat = chatMessages.length > 0;
  const hasExistingAskRepo = askRepoMessages.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: '16px 16px 0' }}>
        <span style={sectionLabel}>Quick actions</span>
      </div>

      <div style={{ padding: '8px 16px 4px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {ACTIONS.map((a) => (
          <ActionTile key={a.key} action={a} onClick={() => handleActionClick(a)} />
        ))}
      </div>

      <div style={{ padding: '4px 16px 4px' }}>
        <button
          onClick={() => setView('chat')}
          style={{
            width: '100%',
            textAlign: 'left',
            background: C.bgSec,
            border: `1px solid ${C.borderMuted}`,
            borderRadius: 9,
            padding: '10px 12px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: C.bgTer,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.muted,
              flexShrink: 0,
            }}
          >
            <AskGitGuideIcon />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>
              {hasExistingChat ? 'Continue Conversation' : 'Ask GitGuide'}
            </div>
            <div style={{ fontSize: 10.5, color: C.mutedDim, lineHeight: 1.4, marginTop: 1 }}>
              {hasExistingChat ? 'Pick up where you left off' : 'Ask custom questions about this repository'}
            </div>
          </div>
        </button>
      </div>

      <div style={{ padding: '4px 16px 16px' }}>
        <button
          onClick={() => setView('ask-repo')}
          style={{
            width: '100%',
            textAlign: 'left',
            background: C.bgSec,
            border: `1px solid ${C.borderMuted}`,
            borderRadius: 9,
            padding: '10px 12px',
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: 7,
              background: C.bgTer,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.muted,
              flexShrink: 0,
            }}
          >
            <AskRepoIcon />
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>
              {hasExistingAskRepo ? 'Continue Ask Repository' : 'Ask Repository'}
            </div>
            <div style={{ fontSize: 10.5, color: C.mutedDim, lineHeight: 1.4, marginTop: 1 }}>
              Search the codebase, get cited answers
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
