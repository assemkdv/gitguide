// MAIN world, document_start: patches history.pushState/replaceState so GitGuide's
// isolated-world content script can react to GitHub's client-side navigation instantly.
// Isolated-world scripts get their own copy of `history`, so patching from there would
// never see the page's own pushState calls — this has to run in the page's world and
// signal back via a DOM event, which both worlds share.
(function patchHistory() {
  const fire = () => window.dispatchEvent(new Event('gitguide:navigation'));

  const origPushState = history.pushState;
  history.pushState = function (...args: Parameters<History['pushState']>) {
    const result = origPushState.apply(this, args);
    fire();
    return result;
  };

  const origReplaceState = history.replaceState;
  history.replaceState = function (...args: Parameters<History['replaceState']>) {
    const result = origReplaceState.apply(this, args);
    fire();
    return result;
  };

  window.addEventListener('popstate', fire);
})();
