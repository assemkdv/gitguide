import React, { useState } from 'react';
import ReactMarkdown, { Components, defaultUrlTransform } from 'react-markdown';
import { SC as C } from './shared';

// Renders model output as Markdown, safely:
// - raw HTML in the text is never rendered (skipHtml);
// - links go through react-markdown's URL sanitizer, and only http(s) links become
//   clickable (opened in a new tab without opener/referrer);
// - images are shown as their alt text, so model output can't load remote images
//   (tracking pixels) into the page.

function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (React.isValidElement(node)) return textOf((node.props as { children?: React.ReactNode }).children);
  return '';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const code = textOf(children).replace(/\n$/, '');
  const language = React.isValidElement(children)
    ? /language-([\w-]+)/.exec(String((children.props as { className?: string }).className ?? ''))?.[1]
    : undefined;
  return (
    <div className="gg-codeblock">
      <div className="gg-codeblock-bar">
        <span>{language ?? 'code'}</span>
        <button
          type="button"
          className="gg-linkbtn"
          aria-label="Copy code"
          onClick={async () => {
            setState((await copyText(code)) ? 'copied' : 'failed');
            setTimeout(() => setState('idle'), 1400);
          }}
        >
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a({ href, children }) {
    if (!href || !/^https?:\/\//i.test(href)) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="gg-link">
        {children}
        <span className="gg-sr-only"> (opens in a new tab)</span>
      </a>
    );
  },
  img({ alt }) {
    return <span>{alt ? `[image: ${alt}]` : '[image]'}</span>;
  },
  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="gg-md" style={{ color: C.textSub }}>
      <ReactMarkdown skipHtml components={components} urlTransform={defaultUrlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const MARKDOWN_CSS = `
.gg-md { font-size: 13px; line-height: 1.6; word-break: break-word; }
.gg-md > :first-child { margin-top: 0; }
.gg-md > :last-child { margin-bottom: 0; }
.gg-md p { margin: 0 0 8px; }
.gg-md ul, .gg-md ol { margin: 0 0 8px; padding-left: 20px; }
.gg-md li { margin: 2px 0; }
.gg-md h1, .gg-md h2, .gg-md h3, .gg-md h4 { font-size: 13px; font-weight: 600; color: ${C.text}; margin: 12px 0 6px; }
.gg-md code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: ${C.bgTer}; border: 1px solid ${C.borderMuted}; border-radius: 4px; padding: 0 4px; }
.gg-md blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid ${C.border}; color: ${C.muted}; }
.gg-md table { border-collapse: collapse; margin: 0 0 8px; display: block; overflow-x: auto; }
.gg-md th, .gg-md td { border: 1px solid ${C.borderMuted}; padding: 3px 6px; }
.gg-codeblock { border: 1px solid ${C.borderMuted}; border-radius: 6px; margin: 0 0 8px; background: ${C.bg}; overflow: hidden; }
.gg-codeblock-bar { display: flex; justify-content: space-between; align-items: center; padding: 3px 8px; font-size: 10.5px; color: ${C.mutedDim}; border-bottom: 1px solid ${C.borderMuted}; }
.gg-codeblock pre { margin: 0; padding: 8px 10px; overflow-x: auto; }
.gg-codeblock pre code { background: none; border: none; padding: 0; white-space: pre; }
.gg-link { color: #58a6ff; text-decoration: underline; text-underline-offset: 2px; }
.gg-linkbtn { background: none; border: none; color: ${C.muted}; cursor: pointer; font: inherit; padding: 2px 4px; border-radius: 4px; }
.gg-linkbtn:hover { color: ${C.text}; }
.gg-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
`;
