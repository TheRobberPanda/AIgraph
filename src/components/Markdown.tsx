import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { splitRecall } from "../lib/recall";
import RecallHighlight from "./RecallHighlight";

/**
 * Renders a model reply.
 *
 * Models write markdown whether or not you ask them to — headings, bold, lists,
 * tables. Showing the raw asterisks made replies noticeably harder to read.
 *
 * Only the assistant's text goes through this. The user's own turns are rendered
 * verbatim: their exact characters are what quotes are matched against, and
 * markdown would render some of them away.
 *
 * A paragraph that drew on something recorded earlier — see `lib/recall.ts` —
 * is split out and wrapped in its own highlight. Split by paragraph rather
 * than rendered as one block: it's the same set of elements ReactMarkdown
 * would produce from the whole string in the ordinary case, since paragraphs
 * are already block boundaries, so a reply with no recall in it renders
 * identically either way.
 */
export default function Markdown({ children }: { children: string }) {
  const segments = splitRecall(children);
  return (
    <div className="md">
      {segments.map((seg, i) =>
        seg.ideaId === null ? (
          <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>
            {seg.text}
          </ReactMarkdown>
        ) : (
          <RecallHighlight key={i} ideaId={seg.ideaId}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{seg.text}</ReactMarkdown>
          </RecallHighlight>
        ),
      )}
    </div>
  );
}
