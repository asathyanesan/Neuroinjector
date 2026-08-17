import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Rich markdown rendering for the Neuroinjector assistant.
// Ported from the teal/slate assistant design, but mapped onto the
// Neuroinjector CSS-variable theme (no Tailwind). All styling lives in
// index.css under the ".md" scope — see the "Rich markdown rendering" block.
export default function MarkdownMessage({ content }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p:  ({ node, ...props }) => <p className="md-p" {...props} />,
          h1: ({ node, ...props }) => <h1 className="md-h1" {...props} />,
          h2: ({ node, ...props }) => <h2 className="md-h2" {...props} />,
          h3: ({ node, ...props }) => <h3 className="md-h3" {...props} />,
          h4: ({ node, ...props }) => <h4 className="md-h4" {...props} />,
          ul: ({ node, ...props }) => <ul className="md-ul" {...props} />,
          ol: ({ node, ...props }) => <ol className="md-ol" {...props} />,
          li: ({ node, ...props }) => <li className="md-li" {...props} />,
          strong: ({ node, ...props }) => <strong className="md-strong" {...props} />,
          em: ({ node, ...props }) => <em className="md-em" {...props} />,
          hr: ({ node, ...props }) => <hr className="md-hr" {...props} />,
          blockquote: ({ node, ...props }) => <blockquote className="md-blockquote" {...props} />,
          a: ({ node, ...props }) => (
            <a className="md-a" target="_blank" rel="noopener noreferrer" {...props} />
          ),
          code: ({ node, inline, ...props }) =>
            inline
              ? <code className="md-code-inline" {...props} />
              : <code className="md-code-block" {...props} />,
          pre: ({ node, ...props }) => <pre className="md-pre" {...props} />,
          table: ({ node, ...props }) => (
            <div className="md-table-wrap">
              <table className="md-table" {...props} />
            </div>
          ),
          thead: ({ node, ...props }) => <thead className="md-thead" {...props} />,
          th: ({ node, ...props }) => <th className="md-th" {...props} />,
          td: ({ node, ...props }) => <td className="md-td" {...props} />,
          tr: ({ node, ...props }) => <tr className="md-tr" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
