import React, { useEffect, useState } from 'react';
import type { UiError } from '../store';

export const SC = {
  bg: '#0d1117',
  bgSec: '#161b22',
  bgTer: '#1c2128',
  border: '#30363d',
  borderMuted: '#21262d',
  text: '#e6edf3',
  textSub: '#c9d1d9',
  muted: '#8b949e',
  mutedDim: '#6e7681',
  accent: '#E7E9EE',
  accentDim: 'rgba(231,233,238,0.08)',
  accentBorder: 'rgba(231,233,238,0.18)',
} as const;

export const sectionLabel: React.CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 600,
  color: '#484f58',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
    >
      <path d="M4 6 L8 10 L12 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Collapsible({
  title,
  icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: `1px solid ${SC.borderMuted}`, borderRadius: 9, marginTop: 8, overflow: 'hidden' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          padding: '9px 11px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          cursor: 'pointer',
          fontFamily: 'inherit',
          color: SC.text,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600 }}>
          <span style={{ color: SC.accent, display: 'flex' }}>{icon}</span>
          {title}
        </span>
        <span style={{ color: SC.mutedDim }}>
          <ChevronIcon open={open} />
        </span>
      </button>
      {open && <div style={{ padding: '0 12px 12px' }}>{children}</div>}
    </div>
  );
}

export function BackButton({ onClick, label = 'Back to Quick Actions' }: { onClick: () => void; label?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none',
        border: 'none',
        color: hovered ? SC.text : SC.muted,
        cursor: 'pointer',
        fontSize: 12,
        fontFamily: 'inherit',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        flexShrink: 0,
        transition: 'color 0.12s',
      }}
    >
      <span style={{ fontSize: 13 }} aria-hidden="true">←</span>
      {label}
    </button>
  );
}

function FooterButton({ onClick, label, title }: { onClick: () => void; label: string; title?: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        fontSize: 11.5,
        color: hovered ? SC.text : SC.muted,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'color 0.12s',
      }}
    >
      {label}
    </button>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ResultFooter({
  getText,
  onContinueInChat,
  onRefresh,
}: {
  getText: () => string;
  onContinueInChat: () => void;
  onRefresh?: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    const text = getText();
    if (!text) return;
    setCopyState((await writeClipboard(text)) ? 'copied' : 'failed');
    setTimeout(() => setCopyState('idle'), 1500);
  };

  const handleOpenInTab = () => {
    const text = getText();
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div style={{ borderTop: `1px solid ${SC.borderMuted}`, flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 14, padding: '12px 16px 10px' }}>
        <FooterButton onClick={handleCopy} label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'} />
        <FooterButton onClick={handleOpenInTab} label="Open in tab" />
        {onRefresh && <FooterButton onClick={onRefresh} label="Refresh" title="Ignore the saved copy and explain again" />}
      </div>
      <div style={{ padding: '0 16px 14px' }}>
        <button
          onClick={onContinueInChat}
          style={{
            width: '100%',
            background: 'none',
            border: `1px solid ${SC.borderMuted}`,
            borderRadius: 8,
            padding: '8px 12px',
            color: SC.muted,
            fontSize: 12,
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            transition: 'color 0.12s, border-color 0.12s',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = SC.text;
            e.currentTarget.style.borderColor = SC.accent;
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = SC.muted;
            e.currentTarget.style.borderColor = SC.borderMuted;
          }}
        >
          Ask about this →
        </button>
      </div>
    </div>
  );
}

export function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        const text = getText();
        if (!text) return;
        setCopied(await writeClipboard(text));
        setTimeout(() => setCopied(false), 1300);
      }}
      title="Copy"
      aria-label="Copy explanation"
      style={{
        background: 'none',
        border: 'none',
        color: SC.mutedDim,
        cursor: 'pointer',
        fontSize: 10.5,
        fontFamily: 'inherit',
        padding: '2px 4px',
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

const PROGRESS_INTERVAL_MS = 1100;

export function LoadingTicker({
  steps,
  title,
  subtitle,
}: {
  steps: string[];
  title?: string;
  subtitle?: string;
}) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (i >= steps.length - 1) return;
    const t = setTimeout(() => setI((n) => Math.min(n + 1, steps.length - 1)), PROGRESS_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [i, steps.length]);

  return (
    <div role="status" aria-live="polite" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {title && (
        <div>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: SC.text }}>{title}</p>
          {subtitle && (
            <p style={{ margin: '3px 0 0', fontSize: 12, color: SC.muted, lineHeight: 1.5 }}>&ldquo;{subtitle}&rdquo;</p>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: SC.accent,
            flexShrink: 0,
            animation: 'pulse 1.2s ease-in-out infinite',
          }}
        />
        <span style={{ fontSize: 12.5, color: SC.muted }}>{steps[i]}</span>
      </div>
    </div>
  );
}

export function ErrorCard({ error, onRetry }: { error: UiError; onRetry: () => void }) {
  const message = error.message;
  return (
    <div role="alert" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <span
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: 'rgba(248,81,73,0.08)',
            border: '1px solid rgba(248,81,73,0.18)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: '#f85149',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          !
        </span>
        <p style={{ margin: 0, color: SC.muted, fontSize: 12.5, lineHeight: 1.6 }}>{message}</p>
      </div>
      {error.retryable && <button
        type="button"
        onClick={onRetry}
        style={{
          alignSelf: 'flex-start',
          background: 'none',
          border: `1px solid ${SC.border}`,
          borderRadius: 6,
          padding: '5px 12px',
          color: SC.muted,
          fontSize: 11.5,
          cursor: 'pointer',
          fontFamily: 'inherit',
          marginLeft: 26,
        }}
      >
        Retry
      </button>}
    </div>
  );
}
