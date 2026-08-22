import { useCallback, useEffect, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { loadGraph, type GraphNode } from "../lib/graph";
import { onIdeasChanged } from "../lib/ideas";
import { categoryColors, UNCATEGORISED } from "../lib/categories";

/**
 * The map, drawn on a 2D canvas over a live force simulation.
 *
 * Deliberately **not** WebGL: Sigma.js renders nodes through WebGL, and in
 * WebKitGTK — which Tauri uses on Linux — that layer silently produced nothing.
 * Canvas 2D works wherever a webview does, and at the scale one person's
 * thinking reaches it draws well inside a frame.
 *
 * The layout runs continuously rather than being computed once. A settled
 * picture is easier to memorise, but a map you can push around and watch settle
 * tells you more about how strongly things are connected — and it invites you to
 * poke at it, which is the point of having one.
 */

const CONVERSATION_RADIUS = 15;
const IDEA_RADIUS = 7;
const LABEL_CHARS = 44;
/** Fitts's law: a 7px dot is not a target. */
const MIN_HIT_RADIUS = 16;

interface Node extends SimulationNodeDatum {
  data: GraphNode;
  r: number;
  color: string;
}

interface Link extends SimulationLinkDatum<Node> {
  kind: string;
}

interface Palette {
  conversation: string;
  edge: string;
  related: string;
  contradicts: string;
  labelConversation: string;
  labelIdea: string;
  labelHover: string;
  halo: string;
  hoverRing: string;
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback;
}

/** Read from the stylesheet so the map follows the theme like everything else. */
function readPalette(): Palette {
  const st = getComputedStyle(document.documentElement);
  const accent = token(st, "--accent", "#7fa8c9");
  const gold = token(st, "--gold", "#d9a34a");
  const muted = token(st, "--muted", "#9a9186");
  const fg = token(st, "--fg", "#ece5d9");
  const line = token(st, "--line", "#2c2722");
  const danger = token(st, "--danger", "#c96b5f");
  return {
    conversation: accent,
    edge: `color-mix(in srgb, ${muted} 55%, ${line})`,
    related: `color-mix(in srgb, ${accent} 55%, transparent)`,
    contradicts: `color-mix(in srgb, ${danger} 70%, transparent)`,
    labelConversation: accent,
    labelIdea: `color-mix(in srgb, ${muted} 85%, transparent)`,
    labelHover: fg,
    halo: `color-mix(in srgb, ${gold} 18%, transparent)`,
    hoverRing: `color-mix(in srgb, ${fg} 16%, transparent)`,
  };
}

function short(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > LABEL_CHARS ? `${clean.slice(0, LABEL_CHARS)}…` : clean;
}

export default function Graph({
  onOpenIdea,
  onOpenConversation,
}: {
  onOpenIdea: (ideaId: number) => void;
  onOpenConversation: (sessionId: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef<Palette>(readPalette());
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<Node | null>(null);
  const dragNodeRef = useRef<Node | null>(null);
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frameRef = useRef(0);
  const startedRef = useRef(performance.now());

  const [hovered, setHovered] = useState<GraphNode | null>(null);
  /** Where the hovered node sat, so the pointer can travel out to its notes. */
  const keepAliveRef = useRef<{ x: number; y: number; r: number } | null>(null);
  const [hoverAt, setHoverAt] = useState<
    { x: number; y: number; r: number; color: string; below: boolean } | null
  >(null);
  const [empty, setEmpty] = useState(false);
  const [legend, setLegend] = useState<[string, string][]>([]);

  const openIdea = useRef(onOpenIdea);
  openIdea.current = onOpenIdea;
  const openConversation = useRef(onOpenConversation);
  openConversation.current = onOpenConversation;

  const toScreen = useCallback((n: { x?: number; y?: number }, w: number, h: number) => {
    const v = viewRef.current;
    return {
      x: (n.x ?? 0) * v.scale + v.x + w / 2,
      y: (n.y ?? 0) * v.scale + v.y + h / 2,
    };
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }

    const C = paletteRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const hover = hoverRef.current;
    // Hovering an idea lifts everything in the same category and pushes the rest
    // back, so a subject can be picked out of the whole map at once.
    const focus = hover?.data.category || null;
    const inFocus = (n: Node) =>
      !focus || (n.data.kind === "idea" && n.data.category === focus) || n === hover;

    for (const link of linksRef.current) {
      const a = link.source as Node;
      const b = link.target as Node;
      const sa = toScreen(a, w, h);
      const sb = toScreen(b, w, h);
      const lit = !focus || inFocus(a) || inFocus(b);
      ctx.globalAlpha = lit ? 1 : 0.18;
      ctx.strokeStyle =
        link.kind === "contradicts"
          ? C.contradicts
          : link.kind === "related"
            ? C.related
            : C.edge;
      ctx.lineWidth = link.kind === "from" ? 1 : 1.4;
      if (link.kind === "related") ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);
      const r = n.r * Math.max(0.6, Math.min(viewRef.current.scale, 2));
      ctx.globalAlpha = inFocus(n) ? 1 : 0.22;

      if (hover === n) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = C.hoverRing;
        ctx.fill();
      }
      if (n.data.shared) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = C.halo;
        ctx.fill();
      }

      // A claim that was rewritten while you were away gets a slow ring, so the
      // change is noticed rather than found later by accident.
      if (n.data.just_revised) {
        const t = ((performance.now() - startedRef.current) / 1600) % 1;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6 + t * 16, 0, Math.PI * 2);
        ctx.strokeStyle = C.labelConversation;
        ctx.globalAlpha = (1 - t) * (inFocus(n) ? 0.55 : 0.15);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = inFocus(n) ? 1 : 0.22;
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
    }

    // Labels last so nothing is drawn over them. A small map has room to name
    // every idea; a large one would become a wall of text.
    const roomy = nodesRef.current.length <= 25;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of nodesRef.current) {
      const isConversation = n.data.kind === "conversation";
      if (!(roomy || isConversation || n.data.shared || hover === n)) continue;
      ctx.globalAlpha = inFocus(n) ? 1 : 0.2;
      const s = toScreen(n, w, h);
      const r = n.r * Math.max(0.6, Math.min(viewRef.current.scale, 2));
      ctx.font = isConversation
        ? "600 13.5px ui-sans-serif, system-ui, sans-serif"
        : "13px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle =
        hover === n ? C.labelHover : isConversation ? C.labelConversation : C.labelIdea;
      ctx.fillText(short(n.data.label), s.x, s.y + r + 7);
    }
    ctx.globalAlpha = 1;
  }, [toScreen]);

  /** Frame the whole map. */
  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const nodes = nodesRef.current;
    if (!canvas || !nodes.length || !canvas.clientWidth) return;

    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const pad = Math.max(...nodes.map((n) => n.r)) + 80;
    const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2);
    const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2);
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    const scale = Math.min(
      (canvas.clientWidth - 80) / spanX,
      (canvas.clientHeight - 80) / spanY,
      2.2,
    );
    viewRef.current = { x: -midX * scale, y: -midY * scale, scale };
  }, []);

  const build = useCallback(async () => {
    const data = await loadGraph();
    setEmpty(data.nodes.length === 0);

    const colors = categoryColors(data.nodes.map((n) => n.category));
    setLegend([...colors.entries()]);

    const C = paletteRef.current;
    // Reuse positions of nodes that already exist, so re-extraction does not
    // throw the whole map in the air.
    const previous = new Map(nodesRef.current.map((n) => [n.data.id, n]));
    const nodes: Node[] = data.nodes.map((d) => {
      const old = previous.get(d.id);
      return {
        data: d,
        r:
          d.kind === "conversation"
            ? CONVERSATION_RADIUS + Math.min(12, d.weight * 2)
            : IDEA_RADIUS + Math.min(8, (d.weight - 1) * 4),
        color:
          d.kind === "conversation"
            ? C.conversation
            : colors.get(d.category) ?? UNCATEGORISED,
        x: old?.x ?? (Math.random() - 0.5) * 400,
        y: old?.y ?? (Math.random() - 0.5) * 400,
      };
    });

    const byId = new Map(nodes.map((n) => [n.data.id, n]));
    const links: Link[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        kind: e.kind,
      }));

    nodesRef.current = nodes;
    linksRef.current = links;

    simRef.current?.stop();
    const sim = forceSimulation<Node, Link>(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .id((n) => n.data.id)
          // Ideas sit close to the conversation they came from; a merely related
          // pair is held further apart, so distance means something.
          .distance((l) => (l.kind === "from" ? 90 : 190))
          .strength((l) => (l.kind === "from" ? 0.7 : 0.15)),
      )
      // Bigger nodes push harder, so conversations claim their own space.
      .force("charge", forceManyBody<Node>().strength((n) => -40 - n.r * 9))
      .force("collide", forceCollide<Node>().radius((n) => n.r + 14))
      // Strong enough to hold the map around the origin, so the initial framing
      // stays valid as the simulation keeps moving. Too weak and it slowly
      // wanders out of view while you watch it.
      .force("center", forceCenter(0, 0).strength(0.25))
      .alphaDecay(0.02)
      // Never freezes completely: a nudge keeps it alive enough to respond to a
      // drag without needing to be woken up.
      .alphaMin(0.001)
      .velocityDecay(0.35);

    simRef.current = sim;
    sim.alpha(1).restart();

    // Let it find a shape before framing, or the first fit captures the initial
    // scatter and everything drifts out of view afterwards.
    for (let i = 0; i < 120; i++) sim.tick();
    fitToView();
  }, [fitToView]);

  useEffect(() => {
    void build();
    const sub = onIdeasChanged(() => void build());
    return () => {
      void sub.then((un) => un());
      simRef.current?.stop();
    };
  }, [build]);

  // One render loop for the life of the component. The simulation ticks itself;
  // this only draws, so panning and hovering stay smooth while it settles.
  useEffect(() => {
    const loop = () => {
      draw();
      frameRef.current = requestAnimationFrame(loop);
    };
    frameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameRef.current);
  }, [draw]);

  useEffect(() => {
    const refresh = () => {
      paletteRef.current = readPalette();
      void build();
    };
    const attr = new MutationObserver(refresh);
    attr.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", refresh);
    return () => {
      attr.disconnect();
      media.removeEventListener("change", refresh);
    };
  }, [build]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let first = true;
    const ro = new ResizeObserver(() => {
      if (first) {
        first = false;
        fitToView();
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [fitToView]);

  function screenPos(n: Node) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const s = toScreen(n, canvas.clientWidth, canvas.clientHeight);
    return {
      x: s.x,
      y: s.y,
      r: n.r * Math.max(0.6, Math.min(viewRef.current.scale, 2)),
      color: n.color,
      below: s.y > canvas.clientHeight / 2,
    };
  }

  function nodeAt(clientX: number, clientY: number): Node | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    let best: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      const s = toScreen(n, rect.width, rect.height);
      const drawn = n.r * Math.max(0.6, Math.min(viewRef.current.scale, 2));
      const r = Math.max(drawn + 6, MIN_HIT_RADIUS);
      const d = Math.hypot(px - s.x, py - s.y);
      if (d <= r && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  /** Canvas coordinates to simulation coordinates. */
  function toWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    return {
      x: (clientX - rect.left - rect.width / 2 - v.x) / v.scale,
      y: (clientY - rect.top - rect.height / 2 - v.y) / v.scale,
    };
  }

  return (
    <div
      className="graph-wrap"
      // Hover ends when the pointer leaves the map — not when it lands on the
      // hover overlay, which is part of the hover state. On the canvas, the
      // nudge circles (which start stacked on the node before animating outward)
      // stole the pointer the instant they appeared, clearing the very hover that
      // created them.
      onMouseLeave={() => {
        panRef.current = null;
        if (dragNodeRef.current) {
          dragNodeRef.current.fx = null;
          dragNodeRef.current.fy = null;
          dragNodeRef.current = null;
        }
        hoverRef.current = null;
        keepAliveRef.current = null;
        setHovered(null);
        setHoverAt(null);
      }}
    >
      <canvas
        ref={canvasRef}
        className="graph"
        onMouseDown={(e) => {
          const hit = nodeAt(e.clientX, e.clientY);
          if (hit) {
            // Pinned while held, so the rest of the map reorganises around it.
            dragNodeRef.current = hit;
            const w = toWorld(e.clientX, e.clientY);
            hit.fx = w.x;
            hit.fy = w.y;
            simRef.current?.alphaTarget(0.3).restart();
            // Drop the hover overlay. It is anchored to where the node was when
            // you pointed at it, so during a drag the nudges hang in empty space
            // while the node moves away — and dimming the map is the opposite of
            // what you want while pushing it around.
            hoverRef.current = null;
            setHovered(null);
            setHoverAt(null);
          }
          panRef.current = { x: e.clientX, y: e.clientY, moved: false };
        }}
        onMouseMove={(e) => {
          const drag = dragNodeRef.current;
          if (drag) {
            const w = toWorld(e.clientX, e.clientY);
            drag.fx = w.x;
            drag.fy = w.y;
            if (panRef.current) panRef.current.moved = true;
            return;
          }
          const pan = panRef.current;
          if (pan) {
            const dx = e.clientX - pan.x;
            const dy = e.clientY - pan.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
            viewRef.current.x += dx;
            viewRef.current.y += dy;
            pan.x = e.clientX;
            pan.y = e.clientY;
            return;
          }
          let hit = nodeAt(e.clientX, e.clientY);

          // Reaching for a note means leaving the node — the notes sit in a ring
          // around it, so the pointer crosses bare canvas on the way. Without
          // this the hover clears mid-reach and the notes vanish before they can
          // be read. Hover holds anywhere inside the ring.
          if (!hit && hoverRef.current) {
            const keep = keepAliveRef.current;
            const rect = canvasRef.current?.getBoundingClientRect();
            if (keep && rect) {
              const d = Math.hypot(
                e.clientX - rect.left - keep.x,
                e.clientY - rect.top - keep.y,
              );
              if (d < keep.r) hit = hoverRef.current;
            }
          }

          if (hit === hoverRef.current) return;

          hoverRef.current = hit;
          setHovered(hit?.data ?? null);
          const at = hit ? screenPos(hit) : null;
          setHoverAt(at);
          // The ring, plus the radius of a note circle, plus room to travel.
          keepAliveRef.current = at ? { x: at.x, y: at.y, r: at.r + 62 + 52 } : null;
        }}
        onMouseUp={(e) => {
          const wasDrag = panRef.current?.moved ?? false;
          if (dragNodeRef.current) {
            // Released back into the simulation rather than left pinned, so the
            // map keeps behaving like one thing.
            dragNodeRef.current.fx = null;
            dragNodeRef.current.fy = null;
            dragNodeRef.current = null;
            simRef.current?.alphaTarget(0);
          }
          panRef.current = null;
          if (wasDrag) return;

          const hit = nodeAt(e.clientX, e.clientY);
          if (!hit) return;
          if (hit.data.kind === "idea" && hit.data.idea_id !== null)
            openIdea.current(hit.data.idea_id);
          if (hit.data.kind === "conversation" && hit.data.session_id !== null)
            openConversation.current(hit.data.session_id);
        }}
        onWheel={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const px = e.clientX - rect.left - rect.width / 2;
          const py = e.clientY - rect.top - rect.height / 2;
          const v = viewRef.current;
          const scale = Math.min(4, Math.max(0.15, v.scale * Math.exp(-e.deltaY * 0.0015)));
          const k = scale / v.scale;
          v.x = px - (px - v.x) * k;
          v.y = py - (py - v.y) * k;
          v.scale = scale;
        }}
      />

      {!empty && (
        <button
          className="graph-reset"
          onClick={() => {
            fitToView();
            simRef.current?.alpha(0.4).restart();
          }}
        >
          Fit
        </button>
      )}

      {empty && (
        <p className="empty graph-empty">
          Nothing mapped yet. Have a conversation and press Done.
        </p>
      )}

      {hovered && hoverAt && <Nudges node={hovered} at={hoverAt} />}

      {hovered && (
        <div
          className={`graph-tip ${hoverAt && hoverAt.below ? "top" : "bottom"} ${
            hoverAt && hoverAt.x > (canvasRef.current?.clientWidth ?? 0) / 2 ? "left" : "right"
          }`}
        >
          <span className="muted">
            {hovered.kind === "conversation"
              ? `Conversation · ${hovered.weight} idea${hovered.weight === 1 ? "" : "s"}`
              : hovered.category
                ? hovered.category
                : "Idea"}
            {hovered.shared && ` · returned to in ${hovered.weight} conversations`}
          </span>
          <div className="graph-tip-label">{hovered.label}</div>
          <span className="muted graph-tip-hint">
            Click to open · drag a node · scroll to zoom
          </span>
        </div>
      )}

      <div className="graph-key">
        <span>
          <i style={{ background: "var(--accent)" }} /> conversation
        </span>
        {legend.slice(0, 6).map(([name, color]) => (
          <span key={name}>
            <i style={{ background: color }} /> {name}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The hover treatment: the map dims, and the AI's points on this node animate
 * out from behind it — green where the thinking holds, red where it is thin.
 *
 * DOM over the canvas rather than drawn into it, because these need text, hover
 * states, and transitions. Everything animates on transform and opacity only.
 */
function Nudges({
  node,
  at,
}: {
  node: GraphNode;
  at: { x: number; y: number; r: number; color: string; below: boolean };
}) {
  const points = [
    ...node.strong.map((text) => ({ text, kind: "strong" as const })),
    ...node.weak.map((text) => ({ text, kind: "weak" as const })),
  ];
  if (points.length === 0) return null;

  const radius = at.r + 62;

  return (
    <div className="nudge-layer">
      <div className="wash" />
      <span
        className="hover-node"
        style={
          {
            left: at.x,
            top: at.y,
            width: at.r * 2,
            height: at.r * 2,
            background: at.color,
            "--halo": at.color,
          } as React.CSSProperties
        }
      />
      {points.map((p, i) => {
        const angle = (i / points.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <span
            key={i}
            className={`ai-nudge ${p.kind}${at.below ? " up" : ""}`}
            style={
              {
                left: at.x,
                top: at.y,
                "--dx": `${Math.cos(angle) * radius}px`,
                "--dy": `${Math.sin(angle) * radius}px`,
                animationDelay: `${i * 45}ms`,
              } as React.CSSProperties
            }
          >
            AI
            <span className="ai-text">{p.text}</span>
          </span>
        );
      })}
    </div>
  );
}
