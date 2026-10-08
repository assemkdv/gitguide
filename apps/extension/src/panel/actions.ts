import { useStore, CardType } from './store';
import { runAction } from './runActions';

/** Entry point for every user-initiated AI feature: shows the data notice first if the
 * user hasn't acknowledged it, then continues with the chosen action. */
export function requestAction(action: CardType | 'chat'): void {
  const s = useStore.getState();
  if (!s.consentAccepted) {
    useStore.setState({ pendingConsentAction: action, previousView: s.view, view: 'consent' });
    return;
  }
  if (action === 'chat') {
    useStore.setState({ view: 'chat' });
    return;
  }
  if (s.pageContext) void runAction[action](s.pageContext);
}

export function openSettings(): void {
  const s = useStore.getState();
  if (s.view === 'settings') return;
  useStore.setState({ previousView: s.view, view: 'settings' });
}
