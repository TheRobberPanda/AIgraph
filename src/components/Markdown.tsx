import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a model reply.
 *
 * Models write markdown whether or not you ask them to — headings, bold, lists,
 * tables. Showing the raw asterisks made replies noticeably harder to read.
 *
 * Only the assistant's text goes through this. The user's own turns are rendered
 * verbatim: their exact characters are what quotes are matched against, and
 * markdown would render some of them away.
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
