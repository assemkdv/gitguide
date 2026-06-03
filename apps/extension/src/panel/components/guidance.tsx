import React from 'react';
import { SC as C } from './shared';

function BigFileIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
      <path
        d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M9.25 0.5V4c0 .69.56 1.25 1.25 1.25h3.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 9h6M5 11.5h6M5 6.5h2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function BigIssueIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="10.5" r="1" fill="currentColor" />
      <path d="M8 4.5V8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function CheckItem({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 7, alignItems: 'flex-start', fontSize: 11.5, color: C.mutedDim, lineHeight: 1.5 }}>
      <span style={{ color: '#3fb950', flexShrink: 0, marginTop: 0.5 }}>✓</span>
      <span>{children}</span>
    </div>
  );
}

function GuidanceEmptyState({
  icon,
  title,
  description,
  bullets,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  bullets: string[];
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '34px 26px 26px', gap: 16 }}>
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 12,
          background: C.bgTer,
          border: `1px solid ${C.borderMuted}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: C.accent,
        }}
      >
        {icon}
      </div>
      <div>
        <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600, color: C.text }}>{title}</p>
        <p style={{ margin: 0, fontSize: 12, color: C.muted, lineHeight: 1.65, maxWidth: 230 }}>{description}</p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'flex-start', marginTop: 2 }}>
        {bullets.map((b, i) => (
          <CheckItem key={i}>{b}</CheckItem>
        ))}
      </div>
    </div>
  );
}

export function FileEmptyState() {
  return (
    <GuidanceEmptyState
      icon={<BigFileIcon />}
      title="Open any source file"
      description="Navigate to any source file in this repository. GitGuide will automatically detect it and generate a detailed explanation."
      bullets={[
        "Explains the file's purpose, logic, and architecture",
        'Highlights important dependencies and data flow',
        'Recommends related files to explore next',
      ]}
    />
  );
}

export function IssueEmptyState() {
  return (
    <GuidanceEmptyState
      icon={<BigIssueIcon />}
      title="Open any GitHub Issue"
      description="Navigate to an issue in this repository. GitGuide will automatically detect it and generate a detailed summary."
      bullets={['Reads the issue description', 'Includes discussion context', 'Suggests an implementation approach']}
    />
  );
}
