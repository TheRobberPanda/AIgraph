import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { wireLog, type WireLog as Log, type WireRequest } from "../lib/ideas";

/** How many seconds the chart shows. */
const WINDOW = 120;

/**
 * What is coming back from the model, as it arrives.
 *
 * The queue can only say a read is still running. This says what the running
 * looks like: pings with no tokens is a router waiting on its provider,
 * reasoning with no answer is a model thinking, a trickle of answer is a slow
 * model. Polled rather than pushed — it only matters while someone is looking.
 *
 * The numbers sit on the left and the words themselves on the right, so a slow
 * stretch can be read as well as measured.
 */
export default function WireLog() {
  const [log, setLog] = useState<Log | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** What a right-click just copied, said briefly beside the heading. */
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1400);
  };

  useEffect(() => {
    let live = true;
    const tick = () =>
      wireLog()
        .then((l) => live && setLog(l))
        .catch((e) => live && setError(String(e)));
    void tick();
    const id = window.setInterval(tick, 500);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!log) return null;

  const nowSec = Math.floor(log.now_ms / 1000);
  const bySec = new Map(log.seconds.map((s) => [s.at, s]));
  const bars = Array.from({ length: WINDOW }, (_, i) => {
    const at = nowSec - WINDOW + 1 + i;
    return bySec.get(at) ?? { at, bytes: 0, content: 0, reasoning: 0, pings: 0 };
  });
  const peak = Math.max(1, ...bars.map((b) => b.content + b.reasoning));
  const recent = bars.slice(-5);
  const rate = (k: "content" | "reasoning" | "bytes") =>
    recent.reduce((n, b) => n + b[k], 0) / recent.length;
  const r = log.request;

  return (
    <div className="wire">
      <div className="wire-main">
        <div className="wire-now">
          <Stat label="answer" value={`${Math.round(rate("content"))} ch/s`} />
          <Stat label="reasoning" value={`${Math.round(rate("reasoning"))} ch/s`} />
          <Stat label="on the wire" value={`${Math.round(rate("bytes"))} B/s`} />
        </div>

        <div className="wire-chart" aria-label="Characters received per second, last two minutes">
          {bars.map((b) => (
            <div key={b.at} className="wire-col" title={tip(b)}>
              <div className="wire-bar reasoning" style={{ height: `${(b.reasoning / peak) * 100}%` }} />
              <div className="wire-bar content" style={{ height: `${(b.content / peak) * 100}%` }} />
              {b.pings > 0 && b.content + b.reasoning === 0 && <div className="wire-ping" />}
            </div>
          ))}
        </div>
        <p className="wire-legend">
          <span className="key content" /> answer <span className="key reasoning" /> reasoning{" "}
          <span className="key ping" /> keep-alive only · last {WINDOW}s, peak {peak} ch/s
        </p>

        {r?.reasoning_forced && (
          <p className="wire-forced">
            Reasoning is on for this request — {r.model} will not answer with it off, so it is
            asked to think as little as it allows. The wait before the answer is that thinking.
          </p>
        )}

        {r ? <Request r={r} now={log.now_ms} /> : <p className="blurb">No model request yet since the app started.</p>}

        <h3 className="section">
          Log
          <span className="wire-copied">
            {copied ? `Copied ${copied}` : "right-click a line to copy it, or the space around to copy all"}
          </span>
        </h3>
        {/* Right-click copies: a line on its own, or the whole log from
            anywhere else in it — it is mostly wanted pasted into a bug report. */}
        <ul
          className="wire-events"
          onContextMenu={(ev) => {
            ev.preventDefault();
            const line = (ev.target as HTMLElement).closest("li");
            if (line) copy(line.textContent ?? "", "the line");
            else copy(logText(log), "the whole log");
          }}
        >
          {[...log.events].reverse().map((e, i) => (
            <li key={`${e.at_ms}-${i}`}>
              <span className="wire-time">{new Date(e.at_ms).toLocaleTimeString()}</span> {e.text}
            </li>
          ))}
        </ul>
      </div>

      <Output
        r={r}
        onCopy={(text) => copy(text, "the output")}
      />
    </div>
  );
}

/**
 * What the model has actually written: its reasoning, dimmed, then the answer.
 *
 * Follows the end while you are at the end, and stays put once you scroll up
 * to read something.
 */
function Output({ r, onCopy }: { r: WireRequest | null; onCopy: (text: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const size = (r?.thinking.length ?? 0) + (r?.output.length ?? 0);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [size, r?.started_ms]);

  return (
    <aside className="wire-output">
      <h3 className="section">Output</h3>
      <div
        ref={box}
        className="wire-output-body"
        onContextMenu={(e) => {
          if (!r) return;
          e.preventDefault();
          onCopy([r.thinking && `reasoning:\n${r.thinking}`, r.output && `answer:\n${r.output}`]
            .filter(Boolean)
            .join("\n\n"));
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!r || size === 0 ? (
          <p className="dim">{r && !r.outcome ? "Nothing written yet." : "Nothing to show."}</p>
        ) : (
          <>
            {r.thinking && (
              <pre className="wire-thinking">
                <span className="wire-output-label">reasoning</span>
                {r.thinking}
              </pre>
            )}
            {r.output && (
              <pre className="wire-answer">
                <span className="wire-output-label">answer</span>
                {r.output}
              </pre>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="wire-stat">
      <span className="wire-stat-value">{value}</span>
      <span className="wire-stat-label">{label}</span>
    </div>
  );
}

function tip(b: { at: number; content: number; reasoning: number; bytes: number; pings: number }) {
  return `${new Date(b.at * 1000).toLocaleTimeString()} — ${b.content} answer, ${b.reasoning} reasoning, ${b.bytes} B, ${b.pings} pings`;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** The log as plain lines, oldest first, the way it reads in a paste. */
function logText(log: Log): string {
  return log.events
    .map((e) => `${new Date(e.at_ms).toLocaleTimeString()} ${e.text}`)
    .join("\n");
}

/**
 * A failure's own words, out of the JSON a router wraps them in.
 *
 * "failed (provider unavailable: 404 Not Found: {"error":{"message":"No
 * endpoints found…"}})" squeezed into a table cell was unreadable; the message
 * is the part worth reading, and the rest is kept behind a disclosure.
 */
function failure(outcome: string): string | null {
  if (!outcome.startsWith("failed")) return null;
  const said = outcome.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (said) return said[1].replace(/\\"/g, '"');
  return outcome.replace(/^failed \((.*)\)$/s, "$1");
}

/** The request in flight, or the last one, in numbers. */
function Request({ r, now }: { r: WireRequest; now: number }) {
  const end = r.ended_ms ?? now;
  const writing = r.first_token_ms ? (end - r.first_token_ms) / 1000 : 0;
  const failed = r.outcome ? failure(r.outcome) : null;
  const rows: [string, string][] = [
    ["model", r.model],
    [
      "state",
      failed ? "failed" : (r.outcome ?? (r.streamed ? "running" : "running — not streamed, silent until done")),
    ],
    ["prompt", `${r.prompt_chars.toLocaleString()} chars`],
    ["elapsed", secs(end - r.started_ms)],
    ["first byte", r.first_byte_ms ? `after ${secs(r.first_byte_ms - r.started_ms)}` : "—"],
    ["first token", r.first_token_ms ? `after ${secs(r.first_token_ms - r.started_ms)}` : "none yet"],
    ["silent for", r.outcome ? "—" : secs(now - (r.last_token_ms ?? r.started_ms))],
    ["answer", `${r.content.toLocaleString()} chars`],
    ["reasoning", `${r.reasoning.toLocaleString()} chars`],
    ["average", writing > 0 ? `${Math.round((r.content + r.reasoning) / writing)} ch/s since first token` : "—"],
    ["keep-alives", String(r.pings)],
    ["bytes", r.bytes.toLocaleString()],
  ];
  return (
    <>
      <h3 className="section">{r.outcome ? "Last request" : "Request in flight"}</h3>
      {failed && r.outcome && (
        <div className="wire-failure">
          <p>{failed}</p>
          <details>
            <summary>Full error</summary>
            <pre>{r.outcome}</pre>
          </details>
        </div>
      )}
      <dl className="wire-request">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
