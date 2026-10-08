// MAIN world, document_start, window capture phase: runs before any of GitHub's own key
// listeners, so keys typed into GitGuide never trigger GitHub shortcuts (GitHub's hotkey
// library can't tell that a key came from a text field, because events leaving a shadow
// root are retargeted to the host element).
//
// Stopping the event here also stops it from reaching GitGuide's own panel. So for
// keydown, the guard re-dispatches a copy directly to the focused element *inside* the
// panel's shadow root, with `composed: false` so the copy never leaves the shadow root
// (GitHub can't see it, and this listener isn't re-triggered). If the panel handles the
// key (e.g. Enter to send, Escape to close) and calls preventDefault on the copy, the
// original event's default action (inserting a newline) is prevented too.
const HOST_ID = 'gitguide-host';

const guard = (e: KeyboardEvent) => {
  const host = document.activeElement;
  if (!host || host.id !== HOST_ID) return;
  e.stopImmediatePropagation();
  if (e.type !== 'keydown') return;

  const target = host.shadowRoot?.activeElement;
  if (!target) return;
  const copy = new KeyboardEvent('keydown', {
    key: e.key,
    code: e.code,
    location: e.location,
    repeat: e.repeat,
    isComposing: e.isComposing,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    metaKey: e.metaKey,
    bubbles: true,
    cancelable: true,
    composed: false,
  });
  if (!target.dispatchEvent(copy)) e.preventDefault();
};

window.addEventListener('keydown', guard, true);
window.addEventListener('keyup', guard, true);
window.addEventListener('keypress', guard, true);
