// Timing/diagnostic logging for the file-detection pipeline (see file-detection.ts,
// App.tsx, runActions.ts). Gated on Vite's build-time DEV flag so these never ship in
// the production bundle — `import.meta.env.DEV` is statically replaced at build time,
// so a production build tree-shakes the calls out entirely rather than just hiding them.
export function devLog(message: string): void {
  if (import.meta.env.DEV) {
    console.log(`[GitGuide] ${message}`);
  }
}
