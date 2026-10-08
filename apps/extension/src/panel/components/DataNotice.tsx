import { useEffect, useRef, useState } from 'react';
import { useStore, CardType } from '../store';
import { saveConsent, clearAllHistoryAndCaches } from '../storage';
import { runAction } from '../runActions';
import { resetChatState } from '../chat';
import { API_BASE_URL, PRIVACY_POLICY_URL } from '../../config';
import { SC as C, BackButton } from './shared';

const apiHost = (() => {
  try {
    return new URL(API_BASE_URL).host;
  } catch {
    return API_BASE_URL;
  }
})();

/** What GitGuide actually sends, in plain language. Shown before the first AI request
 * and again in Settings; keep it in sync with docs/PRIVACY.md. */
export function DataFlowSummary() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
      <p style={{ margin: 0 }}>
        GitGuide works with <strong style={{ color: C.text }}>public GitHub repositories only</strong>. When you use an action or ask a question, your
        browser sends the GitGuide server ({apiHost}):
      </p>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>which repository, branch/tag, file path, or issue number you are viewing;</li>
        <li>for Ask GitGuide: your question and the last few messages of that conversation.</li>
      </ul>
      <p style={{ margin: 0 }}>
        The server then reads the public files, README, issue and comments directly from GitHub and sends them, with your question, to the AI
        provider <strong style={{ color: C.text }}>Groq</strong> to generate the answer. GitGuide does not send your GitHub login, cookies, or
        the contents of the page you are on, and never sends anything about repositories it detects as private.
      </p>
      <p style={{ margin: 0 }}>
        Conversations and cached explanations are stored only in this browser until you clear them. Don&apos;t put secrets or personal
        information in questions.
      </p>
      <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="gg-link" style={{ fontSize: 12 }}>
        Read the privacy policy (opens in a new tab)
      </a>
    </div>
  );
}

export function DataNotice() {
  const { pendingConsentAction, previousView, pageContext } = useStore();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const accept = async () => {
    const saved = await saveConsent();
    setSaveFailed(!saved);
    const pending = pendingConsentAction;
    useStore.setState({ consentAccepted: true, pendingConsentAction: null });
    if (pending === 'chat') {
      useStore.setState({ view: 'chat' });
    } else if (pending && pageContext) {
      void runAction[pending as CardType](pageContext);
    } else {
      useStore.setState({ view: previousView === 'consent' ? 'home' : previousView });
    }
  };

  const decline = () => useStore.setState({ pendingConsentAction: null, view: 'home' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: '18px 18px 16px', gap: 14 }}>
      <h2 ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: 14, fontWeight: 600, color: C.text, outline: 'none' }}>
        Before GitGuide sends anything
      </h2>
      <DataFlowSummary />
      {saveFailed && (
        <p role="alert" style={{ margin: 0, fontSize: 11.5, color: '#d29922' }}>
          Your choice couldn&apos;t be saved, so GitGuide will ask again next time.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          onClick={accept}
          style={{ background: C.accent, color: C.bg, border: 'none', borderRadius: 7, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          I understand, continue
        </button>
        <button
          type="button"
          onClick={decline}
          style={{ background: 'none', color: C.muted, border: `1px solid ${C.border}`, borderRadius: 7, padding: '7px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

export function SettingsView() {
  const { previousView, consentAccepted } = useStore();
  const [status, setStatus] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const back = () => useStore.setState({ view: previousView === 'settings' ? 'home' : previousView });

  const clearAll = async () => {
    const ok = await clearAllHistoryAndCaches();
    resetChatState();
    useStore.getState().resetResults();
    setConfirming(false);
    setStatus(ok ? 'All conversations and cached explanations were deleted from this browser.' : 'Could not clear browser storage. Please try again.');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <BackButton onClick={back} label="Back" />
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <section aria-labelledby="gg-privacy-heading" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="gg-privacy-heading" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.text }}>
            Privacy &amp; data
          </h2>
          <DataFlowSummary />
        </section>

        <section aria-labelledby="gg-storage-heading" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 id="gg-storage-heading" style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.text }}>
            Data on this device
          </h2>
          {!confirming ? (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              style={{ alignSelf: 'flex-start', background: 'none', color: C.text, border: `1px solid ${C.border}`, borderRadius: 7, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Clear chat history and cached explanations…
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: C.textSub }}>Delete every saved conversation and explanation?</span>
              <button
                type="button"
                onClick={clearAll}
                style={{ background: '#da3633', color: '#fff', border: 'none', borderRadius: 7, padding: '6px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}
              >
                Delete
              </button>
              <button type="button" className="gg-linkbtn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          )}
          {status && (
            <p role="status" style={{ margin: 0, fontSize: 11.5, color: C.muted }}>
              {status}
            </p>
          )}
          <p style={{ margin: 0, fontSize: 11, color: C.mutedDim, lineHeight: 1.5 }}>
            {consentAccepted ? 'You have acknowledged the data notice.' : 'You have not acknowledged the data notice yet; GitGuide will show it before sending anything.'}{' '}
            Removing the extension also deletes everything it stored.
          </p>
        </section>
      </div>
    </div>
  );
}
