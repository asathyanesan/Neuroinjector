import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownMessage({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: (props) => <p className="msg-p" {...props} />,
        h1: (props) => <h1 className="msg-h" {...props} />,
        h2: (props) => <h2 className="msg-h" {...props} />,
        h3: (props) => <h3 className="msg-h" {...props} />,
        ul: (props) => <ul className="msg-list" {...props} />,
        ol: (props) => <ol className="msg-list" {...props} />,
        code: (props) => <code className="msg-code" {...props} />,
        a: (props) => <a target="_blank" rel="noopener noreferrer" {...props} />,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
