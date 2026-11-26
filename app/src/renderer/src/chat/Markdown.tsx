// Markdown for bot messages. react-markdown builds React elements and skips raw HTML, so model output can't inject
// markup. Links open in the browser: main's window-open handler sends http(s) links there and denies the rest.
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

const plugins = [remarkGfm];

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  );
}
