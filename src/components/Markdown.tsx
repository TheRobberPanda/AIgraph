import { memo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { markRecall, RECALL_SCHEME } from "../lib/recall";
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
 * A sentence that drew on something recorded earlier — see `lib/recall.ts` —
 * arrives here as a link with a `recall:` address, and is drawn as an inline
 * highlight instead of a link. A reply with no recall in it renders exactly as
 * plain markdown.
 */
const components: Components = {
  a({ href, children, node: _node, ...rest }) {
    if (href?.startsWith(RECALL_SCHEME)) {
      const id = Number(href.slice(RECALL_SCHEME.length));
      if (Number.isFinite(id)) return <RecallHighlight ideaId={id}>{children}</RecallHighlight>;
    }
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
};

/** The default sanitiser drops unknown schemes, which would lose the idea id. */
function urlTransform(url: string): string {
  return url.startsWith(RECALL_SCHEME) ? url : defaultUrlTransform(url);
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {markRecall(children)}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Memoized: a reply's text does not change while the surrounding panel does.
 * Without this, selecting a passage in an output to add to the chat re-parsed
 * and re-rendered the whole document on every mouse-up, which is the lag felt
 * when pointing at part of a long PDF. Only the selection state moved.
 */
export default memo(Markdown);
