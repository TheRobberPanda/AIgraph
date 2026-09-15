import Sheet from "./Sheet";
import { IconClose } from "./Icons";
import { modelName } from "../lib/format";
import type { RouterCredits } from "../lib/settings";

export function dollars(n: number): string {
  return `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;
}

/** Fixed order, never cycled: past four models the rest fold into "other". */
const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"];
const OTHER = "var(--faint)";

const R = 42;
const C = 2 * Math.PI * R;

/**
 * One ring: a share of a whole, with the figure in the middle.
 *
 * Arcs are drawn as dashes on one circle, each starting where the last ended,
 * with a small gap of surface between them so neighbours stay apart.
 */
function Ring({
  parts,
  whole,
  value,
  label,
}: {
  parts: { value: number; color: string; tip: string }[];
  whole: number;
  value: string;
  label: string;
}) {
  const gap = parts.length > 1 ? 1.5 : 0;
  let at = 0;
  return (
    <figure className="credit-ring">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${value}`}>
        <circle className="credit-track" cx="50" cy="50" r={R} />
        {whole > 0 &&
          parts.map((p, i) => {
            const len = Math.max(0, (Math.min(p.value, whole) / whole) * C - gap);
            const dash = (
              <circle
                key={i}
                cx="50"
                cy="50"
                r={R}
                className="credit-arc"
                stroke={p.color}
                strokeDasharray={`${len} ${C}`}
                strokeDashoffset={-at}
                data-tip={p.tip}
              />
            );
            at += (Math.min(p.value, whole) / whole) * C;
            return len > 0 ? dash : null;
          })}
      </svg>
      <div className="credit-ring-mid">
        <span className="credit-ring-value">{value}</span>
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

const pct = (part: number, whole: number) =>
  whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";

/**
 * Where the OpenRouter credit went, opened from the figure in the status bar.
 *
 * The status bar can hold one number. This holds the rest: how much of what
 * was bought is gone, how much of all spending was today, this week and this
 * month, and which models the app itself has spent on since it started.
 */
export default function Credits({
  credits,
  onClose,
}: {
  credits: RouterCredits;
  onClose: () => void;
}) {
  const { used, total } = credits;
  const left = total !== null ? Math.max(0, total - used) : null;
  const periods: [string, number | null][] = [
    ["today", credits.daily],
    ["this week", credits.weekly],
    ["this month", credits.monthly],
  ];
  const models = [...credits.by_model].sort((a, b) => b.usd - a.usd);
  const shown = models.slice(0, SERIES.length);
  const rest = models.slice(SERIES.length);
  const restUsd = rest.reduce((n, m) => n + m.usd, 0);
  const runTotal = models.reduce((n, m) => n + m.usd, 0);
  const slices = [
    ...shown.map((m, i) => ({ name: modelName(m.model), usd: m.usd, calls: m.calls, color: SERIES[i] })),
    ...(rest.length
      ? [{ name: `${rest.length} other`, usd: restUsd, calls: rest.reduce((n, m) => n + m.calls, 0), color: OTHER }]
      : []),
  ];

  return (
    <Sheet size="mid" onClose={onClose}>
      <div className="credit-sheet">
        <div className="route-head">
          <h2>OpenRouter credit</h2>
          <span className="row-meta">
            {dollars(used)} spent{total !== null && ` of ${dollars(total)}`}
          </span>
          <button className="icon-btn" data-tip="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <section>
          <h3 className="section">Balance</h3>
          <div className="credit-rings">
            {total !== null && left !== null ? (
              <Ring
                whole={total}
                parts={[{ value: used, color: "var(--accent)", tip: `${dollars(used)} spent` }]}
                value={pct(used, total)}
                label={`spent · ${dollars(left)} left`}
              />
            ) : (
              <p className="dim">This key has no limit and cannot read the account balance — only what it has spent.</p>
            )}
            {credits.limit !== null && credits.limit_remaining !== null && credits.limit !== total && (
              <Ring
                whole={credits.limit}
                parts={[
                  {
                    value: credits.limit - credits.limit_remaining,
                    color: "var(--gold)",
                    tip: `${dollars(credits.limit - credits.limit_remaining)} of the key's limit`,
                  },
                ]}
                value={pct(credits.limit - credits.limit_remaining, credits.limit)}
                label={`of this key's ${dollars(credits.limit)} limit`}
              />
            )}
          </div>
        </section>

        {periods.some(([, v]) => v !== null) && (
          <section>
            <h3 className="section">Recent spending, as a share of everything spent</h3>
            <div className="credit-rings">
              {periods.map(([label, v]) =>
                v === null ? null : (
                  <Ring
                    key={label}
                    whole={used}
                    parts={[{ value: v, color: "var(--accent)", tip: `${dollars(v)} ${label}` }]}
                    value={dollars(v)}
                    label={`${label} · ${pct(v, used)}`}
                  />
                ),
              )}
            </div>
          </section>
        )}

        <section>
          <h3 className="section">By model, since the app started</h3>
          {slices.length === 0 ? (
            <p className="dim">Nothing priced yet. Reads report their cost as they finish.</p>
          ) : (
            <div className="credit-models">
              <Ring
                whole={runTotal}
                parts={slices.map((s) => ({ value: s.usd, color: s.color, tip: `${s.name}: ${dollars(s.usd)}` }))}
                value={dollars(runTotal)}
                label={`${slices.reduce((n, s) => n + s.calls, 0)} priced calls`}
              />
              <table className="credit-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="num">Spent</th>
                    <th className="num">Share</th>
                    <th className="num">Calls</th>
                  </tr>
                </thead>
                <tbody>
                  {slices.map((s) => (
                    <tr key={s.name}>
                      <td>
                        <span className="credit-key" style={{ background: s.color }} />
                        {s.name}
                      </td>
                      <td className="num">{s.usd === 0 ? "free" : dollars(s.usd)}</td>
                      <td className="num">{pct(s.usd, runTotal)}</td>
                      <td className="num">{s.calls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="dim route-note">
          Balance and recent spending are OpenRouter's figures for this key. The models are counted
          here, from the price OpenRouter reports with each read.
        </p>
      </div>
    </Sheet>
  );
}
