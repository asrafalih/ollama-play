import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  content: string;
  className?: string;
};

/**
 * Renders assistant chat content as GitHub-flavored Markdown (tables, lists, code, links).
 */
export function MarkdownMessage({ content, className = "" }: Props) {
  return (
    <div className={`markdown-message text-sm leading-relaxed text-zinc-200 ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 border-b border-zinc-600 pb-1 text-base font-semibold text-zinc-100 first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-3 text-[0.95rem] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1.5 mt-2 text-[0.9rem] font-semibold text-zinc-100 first:mt-0">
              {children}
            </h3>
          ),
          ul: ({ children }) => (
            <ul className="my-2 list-disc space-y-1 pl-5 marker:text-zinc-500">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-zinc-500">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-sky-600/60 pl-3 text-zinc-400 italic">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sky-400 underline decoration-sky-600/50 underline-offset-2 hover:text-sky-300"
            >
              {children}
            </a>
          ),
          hr: () => <hr className="my-4 border-zinc-600" />,
          table: ({ children }) => (
            <div className="my-2 max-w-full overflow-x-auto rounded-lg border border-zinc-700">
              <table className="w-full min-w-[12rem] border-collapse text-left text-xs">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-zinc-900/90 text-zinc-300">{children}</thead>
          ),
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => (
            <tr className="border-b border-zinc-700/80 last:border-0">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="border border-zinc-700 px-2 py-1.5 font-medium">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-zinc-700/80 px-2 py-1.5 text-zinc-300">{children}</td>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-[0.8rem] leading-snug text-zinc-300">
              {children}
            </pre>
          ),
          code(props) {
            const { className, children, ...rest } = props;
            const inline = (props as typeof props & { inline?: boolean }).inline;
            if (inline) {
              return (
                <code
                  className="rounded bg-zinc-950 px-1.5 py-0.5 font-mono text-[0.85em] text-sky-200 ring-1 ring-zinc-700/80"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className ?? ""} block whitespace-pre`} {...rest}>
                {children}
              </code>
            );
          },
          strong: ({ children }) => (
            <strong className="font-semibold text-zinc-50">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-zinc-300">{children}</em>,
          del: ({ children }) => (
            <del className="text-zinc-500 line-through">{children}</del>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
