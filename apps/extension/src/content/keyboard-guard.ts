// MAIN world + window + capture phase: same listener queue as GitHub's scripts,
// registered at document_start so we fire before GitHub registers its shortcuts.
// document.activeElement returns the shadow host when focus is inside shadow DOM.
const block = (e: Event) => {
  if (document.activeElement?.id === 'gitguide-host') {
    e.stopImmediatePropagation();
  }
};

window.addEventListener('keydown', block, true);
window.addEventListener('keyup', block, true);
