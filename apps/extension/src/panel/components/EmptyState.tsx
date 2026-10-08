const C = {
  bg: '#0d1117',
  bgSec: '#161b22',
  border: '#30363d',
  borderMuted: '#21262d',
  text: '#e6edf3',
  muted: '#8b949e',
  accent: '#E7E9EE',
  logoBg: 'linear-gradient(135deg, #171b2e 0%, #0a0b12 100%)',
} as const;

function LogoMark({ size = 48 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: C.logoBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 100 100" fill="none">
        <path d="M46 76 L24 50 L46 24 L78 22" stroke={C.accent} strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="78" cy="22" r="8.5" fill={C.accent} />
      </svg>
    </div>
  );
}

export function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: '32px 28px',
        textAlign: 'center',
        gap: 20,
      }}
    >
      <LogoMark size={52} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text }}>
          Open a public GitHub repository
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 12,
            color: C.muted,
            lineHeight: 1.7,
            maxWidth: 230,
          }}
        >
          GitGuide explains public repositories, files, and issues, and answers
          questions about their code.
        </p>
      </div>

      <div
        style={{
          padding: '7px 12px',
          background: C.bgSec,
          border: `1px solid ${C.borderMuted}`,
          borderRadius: 6,
          fontSize: 11,
          color: C.muted,
          fontFamily: 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace',
        }}
      >
        github.com/owner/repo
      </div>
    </div>
  );
}
