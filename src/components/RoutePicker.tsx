import { useEffect, useState } from "react";
import Sheet from "./Sheet";
import Credits, { dollars } from "./Credits";
import { IconClose } from "./Icons";
import { modelName } from "../lib/format";
import {
  getSettings,
  measureRoute,
  openrouterCredits,
  openrouterEndpoints,
  saveSettings,
  type RouteMeasure,
  type RouterCredits,
  type RouterEndpoint,
} from "../lib/settings";

/** Letting the router rank providers, rather than naming one. */
const SORTS = [
  { value: "", label: "Auto", tip: "OpenRouter's own choice, balancing price and uptime" },
  { value: "sort:price", label: "Cheapest", tip: "Always the lowest price available" },
  { value: "sort:throughput", label: "Fastest output", tip: "The most tokens per second" },
  { value: "sort:latency", label: "Quickest start", tip: "The shortest wait for the first token" },
];

type Col = "provider" | "prompt" | "completion" | "context" | "uptime" | "latency" | "speed";
type Measured = RouteMeasure | "running";

/** A measurement kept from an earlier visit, and when it was taken. */
interface Kept {
  m: RouteMeasure;
  at: number;
}

/**
 * Speeds from earlier measurements, by model and then provider tag.
 *
 * Kept in the browser rather than settings: they are a convenience for this
 * machine, go stale on their own, and nothing is lost if they vanish.
 */
const SPEEDS_KEY = "aigraph-route-speeds";

function loadKept(model: string): Record<string, Kept> {
  try {
    const all = JSON.parse(localStorage.getItem(SPEEDS_KEY) ?? "{}");
    return all?.[model] ?? {};
  } catch {
    return {};
  }
}

function keep(model: string, tag: string, m: RouteMeasure) {
  try {
    const all = JSON.parse(localStorage.getItem(SPEEDS_KEY) ?? "{}") ?? {};
    all[model] = { ...(all[model] ?? {}), [tag]: { m, at: Date.now() } };
    localStorage.setItem(SPEEDS_KEY, JSON.stringify(all));
  } catch {
    // Storage refused: the measurement still shows until the sheet closes.
  }
}

/** "3 hours ago", roughly. */
function ago(at: number): string {
  const min = Math.round((Date.now() - at) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

/** "$1.24 spent · $8.76 left", or just what was spent where there is no total. */
function creditLine(c: RouterCredits): string {
  if (c.total === null) return `${dollars(c.used)} spent`;
  return `${dollars(c.used)} spent · ${dollars(Math.max(0, c.total - c.used))} left`;
}

function routeLabel(route: string): string {
  return SORTS.find((s) => s.value === route)?.label ?? route.split("/")[0];
}

/**
 * Which of OpenRouter's providers serves the current model, from the status bar.
 *
 * One model id on OpenRouter is served by several companies at different
 * prices, precisions and speeds. The router picks one per request unless told
 * otherwise; this is where it is told. It is also where the account's credit
 * is shown, since the price of a provider only means something next to it.
 */
export default function RoutePicker({ model }: { model: string }) {
  const [open, setOpen] = useState(false);
  const [spending, setSpending] = useState(false);
  const [route, setRoute] = useState("");
  const [credits, setCredits] = useState<RouterCredits | null>(null);

  useEffect(() => {
    getSettings()
      .then((s) => setRoute(s.router_routes?.[model] ?? ""))
      .catch(() => {});
  }, [model]);

  // On arrival, whenever the sheet closes, and every few minutes: the figure
  // moves with every read, and a stale one is worse than none.
  useEffect(() => {
    if (open) return;
    const read = () => void openrouterCredits().then(setCredits).catch(() => {});
    read();
    const every = window.setInterval(read, 5 * 60 * 1000);
    return () => window.clearInterval(every);
  }, [open, spending]);

  return (
    <>
      <button
        className="status-toggle"
        data-tip="Which OpenRouter provider serves this model — compare price and speed"
        onClick={() => setOpen(true)}
      >
        route · {routeLabel(route)}
      </button>
      {credits && (
        <button
          className="status-toggle route-credit"
          data-tip="Where the OpenRouter credit went"
          onClick={() => setSpending(true)}
        >
          {creditLine(credits)}
        </button>
      )}
      {spending && credits && <Credits credits={credits} onClose={() => setSpending(false)} />}
      {open && (
        <RouteSheet
          model={model}
          route={route}
          credits={credits}
          onRoute={setRoute}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function RouteSheet({
  model,
  route,
  credits,
  onRoute,
  onClose,
}: {
  model: string;
  route: string;
  credits: RouterCredits | null;
  onRoute: (route: string) => void;
  onClose: () => void;
}) {
  const [endpoints, setEndpoints] = useState<RouterEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Measured since the sheet opened. */
  const [measured, setMeasured] = useState<Record<string, Measured>>({});
  /** Measured on an earlier visit, shown until measured again. */
  const [kept] = useState<Record<string, Kept>>(() => loadKept(model));
  const [sort, setSort] = useState<{ col: Col; asc: boolean }>({ col: "prompt", asc: true });

  useEffect(() => {
    openrouterEndpoints(model)
      .then(setEndpoints)
      .catch((e) => setError(String(e)));
  }, [model]);

  async function choose(value: string) {
    setError(null);
    try {
      const s = await getSettings();
      const routes = { ...(s.router_routes ?? {}) };
      if (value) routes[model] = value;
      else delete routes[model];
      await saveSettings({ ...s, router_routes: routes });
      onRoute(value);
    } catch (e) {
      setError(String(e));
    }
  }

  function measureAll() {
    for (const e of endpoints ?? []) {
      setMeasured((m) => ({ ...m, [e.tag]: "running" }));
      measureRoute(model, e.tag)
        .then((r) => {
          // Only a success is worth keeping: a failure says the provider was
          // down just now, which is exactly what goes stale fastest.
          if (r.ok) keep(model, e.tag, r);
          setMeasured((m) => ({ ...m, [e.tag]: r }));
        })
        .catch((err) =>
          setMeasured((m) => ({
            ...m,
            [e.tag]: { ok: false, first_token_ms: null, tokens_per_s: null, error: String(err) },
          })),
        );
    }
  }

  /** A measurement taken on an earlier visit and not yet taken again. */
  const old = (tag: string): Kept | null => (measured[tag] ? null : (kept[tag] ?? null));
  const done = (tag: string) => {
    const m = measured[tag];
    if (m && m !== "running") return m.ok ? m : null;
    return old(tag)?.m ?? null;
  };
  const latency = (e: RouterEndpoint) => done(e.tag)?.first_token_ms ?? e.latency_ms;
  const speed = (e: RouterEndpoint) => done(e.tag)?.tokens_per_s ?? e.throughput;

  const value = (e: RouterEndpoint): number | string | null =>
    ({
      provider: e.provider.toLowerCase(),
      prompt: e.prompt_price,
      completion: e.completion_price,
      context: e.context,
      uptime: e.uptime,
      latency: latency(e),
      speed: speed(e),
    })[sort.col];

  // Missing figures sort last whichever way the column is turned.
  const rows = [...(endpoints ?? [])].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    const c = x < y ? -1 : x > y ? 1 : 0;
    return sort.asc ? c : -c;
  });

  const head = (col: Col, label: string, num = true, tip?: string) => (
    <th
      className={`${num ? "num" : ""}${sort.col === col ? " on" : ""}`}
      data-tip={tip}
      onClick={() =>
        setSort((s) =>
          s.col === col ? { col, asc: !s.asc } : { col, asc: !["uptime", "speed", "context"].includes(col) },
        )
      }
    >
      {label}
      {sort.col === col ? (sort.asc ? " ↑" : " ↓") : ""}
    </th>
  );

  const price = (n: number) => (n === 0 ? "free" : dollars(n));
  const running = Object.values(measured).some((m) => m === "running");
  // The oldest kept figure actually on screen, for the warning under the table.
  const shownOld = (endpoints ?? []).map((e) => old(e.tag)).filter((k): k is Kept => k !== null);
  const oldest = shownOld.length ? Math.min(...shownOld.map((k) => k.at)) : null;

  return (
    <Sheet size="mid" onClose={onClose}>
      <div className="route-sheet">
        <div className="route-head">
          <h2>Providers for {modelName(model)}</h2>
          <span className="row-meta">{model}</span>
          <button className="icon-btn" data-tip="Close" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {credits && (
          <p className="row-meta route-credit">
            OpenRouter credit: {creditLine(credits)}
            {credits.total !== null && ` of ${dollars(credits.total)}`}
          </p>
        )}

        <div className="route-sorts">
          {SORTS.map((s) => (
            <button
              key={s.value}
              className={route === s.value ? "btn on" : "btn"}
              data-tip={s.tip}
              onClick={() => void choose(s.value)}
            >
              {s.label}
            </button>
          ))}
          <span className="spacer" />
          <button
            className="btn"
            disabled={!endpoints?.length || running}
            data-tip="Sends one short request through each provider — a fraction of a cent each — and times it from here"
            onClick={measureAll}
          >
            {running ? "Measuring…" : oldest !== null ? "Measure again" : "Measure speed"}
          </button>
        </div>

        {error && <p className="route-error">{error}</p>}
        {!endpoints && !error && <p className="dim">Asking OpenRouter who serves this model…</p>}

        {endpoints && (
          <div className="route-table-wrap">
            <table className="route-table">
              <thead>
                <tr>
                  {head("provider", "Provider", false)}
                  {head("prompt", "In $/M", true, "US dollars per million prompt tokens")}
                  {head("completion", "Out $/M", true, "US dollars per million reply tokens")}
                  {head("latency", "First token", true, "Wait before the reply starts — measured from here")}
                  {head("speed", "Speed", true, "Reply tokens per second — measured from here")}
                  {head("uptime", "Uptime", true, "Requests answered over the last 30 minutes")}
                  {head("context", "Context")}
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const m = measured[e.tag];
                  const failed = m && m !== "running" && !m.ok ? m.error : null;
                  const k = old(e.tag);
                  const oldTip = k ? `Measured ${ago(k.at)} — may be out of date` : undefined;
                  const lat = latency(e);
                  const sp = speed(e);
                  return (
                    <tr
                      key={e.tag}
                      className={route === e.tag ? "chosen" : undefined}
                      onClick={() => void choose(e.tag)}
                      data-tip="Prefer this provider — others still stand in if it fails"
                    >
                      <td>
                        {route === e.tag && <span className="route-check">✓ </span>}
                        {e.provider}
                        {e.quantization && e.quantization !== "unknown" && (
                          <span className="quant">{e.quantization}</span>
                        )}
                        {e.tools && <span className="tag">tools</span>}
                        {e.structured && <span className="tag">json</span>}
                      </td>
                      <td className="num">{price(e.prompt_price)}</td>
                      <td className="num">{price(e.completion_price)}</td>
                      <td className={k ? "num route-old" : "num"} data-tip={oldTip}>
                        {m === "running" ? (
                          <span className="dim">…</span>
                        ) : failed ? (
                          <span className="warn" data-tip={failed}>failed</span>
                        ) : lat !== null ? (
                          `${(lat / 1000).toFixed(2)}s${k ? "*" : ""}`
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className={k ? "num route-old" : "num"} data-tip={oldTip}>
                        {sp !== null && m !== "running" && !failed ? (
                          `${Math.round(sp)} tok/s${k ? "*" : ""}`
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                      <td className={`num${e.uptime !== null && e.uptime < 95 ? " warn" : ""}`}>
                        {e.uptime !== null ? `${e.uptime.toFixed(1)}%` : <span className="dim">—</span>}
                      </td>
                      <td className="num">
                        {Math.round(e.context / 1000)}k
                        {e.max_output ? <span className="dim"> / {Math.round(e.max_output / 1000)}k out</span> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {oldest !== null && (
          <p className="route-note route-stale-note">
            * Measured earlier — the oldest {ago(oldest)}. Providers change hardware, load and
            routing all the time, so these speeds may be out of date. Measure again for
            current figures.
          </p>
        )}

        <p className="dim route-note">
          A chosen provider is preferred, not required: if it is down, OpenRouter falls back to
          another rather than the reply failing. OpenRouter doesn't publish speed for most
          providers, so it is measured from this machine.
        </p>
      </div>
    </Sheet>
  );
}
