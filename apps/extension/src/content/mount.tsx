import { createRoot } from 'react-dom/client';
import App from '../panel/App';

const HOST_ID = 'gitguide-host';

function createHost(): void {
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 0',
    'height: 0',
    'z-index: 2147483647',
    'pointer-events: none',
  ].join('; ');

  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const stopKeys = (e: Event) => e.stopPropagation();
  shadow.addEventListener('keydown', stopKeys);
  shadow.addEventListener('keyup', stopKeys);

  const container = document.createElement('div');
  container.style.cssText = 'pointer-events: none;';
  shadow.appendChild(container);

  const root = createRoot(container);
  root.render(<App />);
}

export function mountPanel(): void {
  if (document.getElementById(HOST_ID)) return;
  createHost();

  // GitHub's SPA occasionally replaces large swaths of the document during
  // client-side navigation. If our host node ever gets swept up in that,
  // re-create it immediately so the launcher never silently disappears.
  const observer = new MutationObserver(() => {
    if (!document.getElementById(HOST_ID)) {
      createHost();
    }
  });

  observer.observe(document.documentElement, { childList: true });
}
