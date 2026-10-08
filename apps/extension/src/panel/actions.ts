import { useStore, CardType } from './store';
import { runAction } from './runActions';

/** Entry point for every user-initiated AI feature. Runs right away; the Quick Actions
 * screen shows where the data goes, and Privacy & data has the details. */
export function requestAction(action: CardType | 'chat'): void {
  const s = useStore.getState();
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
