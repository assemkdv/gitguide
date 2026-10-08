import { useState } from 'react';
import { useStore } from '../store';
import { clearAllHistoryAndCaches } from '../storage';
import { openSettings } from '../actions';
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

/** What GitGuide sends and stores, in plain language, for the Privacy & data screen.
 * Keep it in sync with docs/PRIVACY.md. */
export function DataFlowSummary() {
  const p = { margin: 0 } as const;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: C.textSub, lineHeight: 1.6 }}>
      <p style={p}>
        GitGuide works with <strong style={{ color: C.text }}>public repositories only</strong> and sends nothing about a repository it detects as
        private.
      </p>
      <p style={p}>
        When you run an action, GitGuide sends its server ({apiHost}) the repository, branch, file path, or issue number you are viewing. Ask
        GitGuide also sends your question and the last few messages of that chat.
      </p>
      <p style={p}>
        The server reads the public content from GitHub and sends it to <strong style={{ color: C.text }}>Groq</strong>, an AI provider, to write
        the answer. Your GitHub login, cookies, and the page itself are never sent.
      </p>
      <p style={p}>
        Chats and cached explanations stay in this browser until you clear them. Please leave secrets and personal details out of your questions.
      </p>
      <a href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="gg-link" style={{ fontSize: 12 }}>
        Privacy policy (opens in a new tab)
      </a>
    </div>
  );
}

/** Short, non-blocking disclosure shown with the Quick Actions. */
export function DataDisclosure() {
  return (
    <p style={{ margin: 0, fontSize: 10.5, color: C.mutedDim, lineHeight: 1.5 }}>
      Public repositories only. Actions send the repository, file, or issue you choose (and your chat questions) to the GitGuide server, which
      uses Groq to answer.{' '}
      <button
        type="button"
        className="gg-link"
        onClick={openSettings}
        style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
      >
        Privacy &amp; data
      </button>
    </p>
  );
}

export function SettingsView() {
  const { previousView } = useStore();
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
            Removing the extension also deletes everything it stored.
          </p>
        </section>
      </div>
    </div>
  );
}
