// Navigates by synthesizing a real anchor click rather than assigning
// window.location directly. GitHub's client-side router (Turbo) intercepts
// genuine clicks on same-origin links and handles them as a soft navigation
// (pushState), which our nav-patch.ts MAIN-world listener then observes —
// assigning location.href directly would force a full page reload instead,
// tearing down this extension's React tree along with it.
export function navigateToPath(path: string): void {
  const a = document.createElement('a');
  a.href = path;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function navigateToIssue(repoOwner: string, repoName: string, issueNumber: number): void {
  navigateToPath(`https://github.com/${repoOwner}/${repoName}/issues/${issueNumber}`);
}
