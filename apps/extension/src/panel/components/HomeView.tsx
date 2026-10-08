import { useState } from 'react';
import { useStore, CardType } from '../store';
import { requestAction } from '../actions';
import { BookIcon, CodeIcon, MessageIcon, BranchIcon } from './cards';
import { sectionLabel, SC as C } from './shared';

interface ActionSpec {
  key: CardType;
  label: string;
  sub: string;
  icon: () => JSX.Element;
}

const ACTIONS: ActionSpec[] = [
  { key: 'repo', label: 'Explain Repository', sub: 'High-level overview', icon: BookIcon },
  { key: 'file', label: 'Explain File', sub: 'Current file breakdown', icon: CodeIcon },
  { key: 'issue', label: 'Summarize Issue', sub: 'TL;DR + context', icon: MessageIcon },
  { key: 'good-first-issues', label: 'Find Good First Issue', sub: 'Where to contribute', icon: BranchIcon },
];

function ActionTile({ action, onClick }: { action: ActionSpec; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const Icon = action.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
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
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.7 10.7 L14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function HomeView() {
  const { pageContext, chatMessages } = useStore();

  if (!pageContext) return null;

  const handleActionClick = (action: ActionSpec) => requestAction(action.key);
  const hasExistingChat = chatMessages.length > 0;

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

      <div style={{ padding: '12px 16px 0' }}>
        <span style={sectionLabel}>Chat</span>
      </div>

      <div style={{ padding: '8px 16px 16px' }}>
        <button
          type="button"
          onClick={() => requestAction('chat')}
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
              {hasExistingChat ? 'Continue Ask GitGuide' : 'Ask GitGuide'}
            </div>
            <div style={{ fontSize: 10.5, color: C.mutedDim, lineHeight: 1.4, marginTop: 1 }}>
              Search the codebase, get cited answers
            </div>
          </div>
        </button>
      </div>

      <p style={{ margin: 'auto 16px 14px', fontSize: 10.5, color: C.mutedDim, lineHeight: 1.5 }}>
        Public repositories only. AI answers can be wrong — check the linked sources.
      </p>
    </div>
  );
}
