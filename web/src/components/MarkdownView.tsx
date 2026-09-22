import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock({
  className,
  children,
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? '').replace(/\n$/, '');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-slate-700 bg-slate-900 text-slate-100">
      <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-3 py-1 text-[11px] text-slate-400">
        <span className="font-mono">
          {className ? className.replace(/^language-/, '') : '代码'}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          {copied ? '已复制 ✓' : '复制'}
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3 font-mono text-xs leading-relaxed text-slate-100">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml={true}
        components={{
          // Remote images disabled to maintain conservative CSP and privacy
          img: () => null,
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...props }) => {
            const isInline =
              !className && typeof children === 'string' && !children.includes('\n');
            if (isInline) {
              return (
                <code
                  className="rounded bg-slate-200/80 px-1 py-0.5 font-mono text-[0.85em] text-slate-800"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return <CodeBlock className={className}>{children}</CodeBlock>;
          },
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto">
              <table className="min-w-full border-collapse border border-slate-300 text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-300 bg-slate-100 px-2 py-1 text-left font-semibold text-slate-700">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-slate-300 px-2 py-1 text-slate-700">{children}</td>
          ),
          h1: ({ children }) => (
            <h1 className="my-2 text-lg font-bold text-slate-900">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="my-2 text-base font-bold text-slate-900">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="my-1.5 text-sm font-semibold text-slate-900">{children}</h3>
          ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc pl-5 space-y-0.5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal pl-5 space-y-0.5">{children}</ol>
          ),
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-4 border-slate-300 pl-3 italic text-slate-600">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all underline text-emerald-700 hover:text-emerald-900"
            >
              {children}
            </a>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
