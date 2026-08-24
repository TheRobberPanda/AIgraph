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
import { ConversationFile, IdeaFile } from "./Deep";
import FilePanel from "./FilePanel";

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

/**
 * A rough guess at a label's rendered half-width, in the same world units the
 * force simulation already uses for link distance. Nothing here is drawn with
 * this number — it only tells the collision force how much room a long title
 * needs, so nodes spread out enough that every label ends up with space
 * rather than losing a fight over the same patch of canvas.
 */
function estimateLabelHalfWidth(label: string, isConversation: boolean): number {
  const avgCharPx = isConversation ? 7.6 : 6.6;
  const cap = isConversation ? 168 : 120;
  return Math.min(label.length * avgCharPx, cap) / 2;
}

interface Node extends SimulationNodeDatum {
  data: GraphNode;
  r: number;
  color: string;
  /** Half the label's estimated rendered width, so nodes with long titles
   *  push each other further apart instead of drawing over the label. */
  labelHalf: number;
}

interface Link extends SimulationLinkDatum<Node> {
  kind: string;
  /** Why these two relate, in the adjudicator's words. */
  reasoning?: string;
}

interface Palette {
  conversation: string;
  edge: string;
  related: string;
  contradicts: string;
  category: string;
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
  const verdant = token(st, "--verdant", "#7ead6f");
  return {
    conversation: accent,
    edge: `color-mix(in srgb, ${muted} 55%, ${line})`,
    // "related" is shown to the user as a correlation — green, to sit opposite
    // a contradiction rather than blend into the accent color used everywhere
    // else on the map.
    related: `color-mix(in srgb, ${verdant} 70%, transparent)`,
    contradicts: `color-mix(in srgb, ${danger} 70%, transparent)`,
    category: `color-mix(in srgb, ${muted} 30%, transparent)`,
    labelConversation: accent,
    labelIdea: `color-mix(in srgb, ${muted} 85%, transparent)`,
    labelHover: fg,
    halo: `color-mix(in srgb, ${gold} 18%, transparent)`,
    hoverRing: `color-mix(in srgb, ${fg} 16%, transparent)`,
  };
}

/**
 * Truncate to an actual pixel width, not a character count.
 *
 * A character count is only a proxy for width, and a title with wide capital
 * letters or an unusually long word overflowed it — nodes recorded before this
 * fix still carry long opening-sentence titles, which is why they were the ones
 * visibly cut off. Measuring the real rendered width fixes both old and new
 * labels the same way.
 */
function fitWidth(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo).trimEnd() + "…";
}

/**
 * Break a label across lines instead of cutting it off.
 *
 * Titles are short AI-written names now, not sliced-out sentences, so the
 * right behaviour is to show the whole thing on two or three lines rather
 * than lose words to an ellipsis. A single absurdly long word still falls
 * back to `fitWidth` so it cannot blow out the layout.
 */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
  maxLines: number,
): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    // Once the last allowed line is being built, stop wrapping and just
    // accumulate everything left — it gets pixel-truncated with an ellipsis
    // below, rather than silently dropping words off the end.
    if (lines.length === maxLines - 1) {
      line = line ? `${line} ${word}` : word;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxPx || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  const last = lines.length - 1;
  if (last >= 0) lines[last] = fitWidth(ctx, lines[last], maxPx);
  return lines;
}

/**
 * How much room the map has, which changes what it should do.
 *
 * In a side panel the spacing that makes a full-pane map readable pushes
 * everything off-screen and leaves nodes too close together to hit. Rather
 * than scaling one set of numbers, the two sizes get their own.
 */
/** A node's drawn radius: zoom, clamped, times the size the map is at. */
function drawnRadius(base: number, scale: number, width: number): number {
  return base * Math.max(0.6, Math.min(scale, 2)) * ruleset(width).nodeScale;
}

function ruleset(width: number) {
  const tight = width < 560;
  return {
    tight,
    /** Orbit radius around a conversation. */
    orbit: tight ? 46 : 90,
    orbitGrowth: tight ? 5 : 14,
    /** How far a merely related pair sits apart. */
    related: tight ? 90 : 190,
    /** Space reserved around a node, label included. */
    padding: tight ? 6 : 20,
    /** A label's share of that space. Almost none when labels are hidden. */
    labelShare: tight ? 0.15 : 1,
    /** Fitts's law, but a crowded panel needs a smaller target or every
     *  click lands on a neighbour. */
    hitRadius: tight ? 11 : 16,
    /** Nodes are drawn smaller in a panel; at full size they crowd it out. */
    nodeScale: tight ? 0.62 : 1,
    charge: tight ? -14 : -40,
    chargeByRadius: tight ? 3 : 9,
  };
}

export default function Graph({ folder }: { folder: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef<Palette>(readPalette());
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<Node | null>(null);
  /** A subject picked out of the legend. Clicking pins it — that is what
   *  reveals titles; hovering only previews the highlight, because a preview
   *  that also rearranged the labels would flicker the map on the way past. */
  const legendPinRef = useRef<string | null>(null);
  const legendHoverRef = useRef<string | null>(null);
  const [legendPin, setLegendPin] = useState<string | null>(null);
  const [legendFocus, setLegendFocus] = useState<string | null>(null);
  /** The node being looked at, and everything it touches: the only ideas
   *  named on the map when no subject is pinned. */
  const focusNodeRef = useRef<Node | null>(null);
  const revealRef = useRef<Set<string>>(new Set());
  /** An idea being pointed at in the open file, so the list and the map are
   *  reading the same thing at the same time. */
  const tracedRef = useRef<number | null>(null);
  /** A view in flight, stepped by the draw loop. Retargeted every frame from
   *  the node's live position, so it lands centred even though the layout is
   *  still moving underneath it. */
  const travelRef = useRef<
    { node: Node; fromX: number; fromY: number; fromScale: number; toScale: number; t0: number } | null
  >(null);
  /** Whether idea titles currently fit without overlapping. Held in a ref with
   *  a dead band so it does not blink on and off while the layout settles. */
  const labelsFitRef = useRef(true);
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

  // Opening a node's file happens over the map, not instead of it — clicking
  // the same node again closes it, clicking a different one swaps the panel's
  // content, rather than navigating away and losing the map's state.
  const [panel, setPanel] = useState<{ kind: "idea" | "conversation"; id: number } | null>(null);
  const [panelSide, setPanelSide] = useState<"left" | "right">("right");
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [edgeHover, setEdgeHover] = useState<{
    kind: "related" | "contradicts";
    a: GraphNode;
    b: GraphNode;
    reasoning?: string;
    x: number;
    y: number;
  } | null>(null);
  const openIdea = useRef((id: number) =>
    setPanel((p) => (p?.kind === "idea" && p.id === id ? null : { kind: "idea", id })),
  );
  const openConversation = useRef((id: number) =>
    setPanel((p) => (p?.kind === "conversation" && p.id === id ? null : { kind: "conversation", id })),
  );

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

    // A click on the map travels the view to what was clicked. Retargeted
    // each frame rather than aimed once, because the node is still drifting.
    const travel = travelRef.current;
    if (travel) {
      const t = Math.min(1, (performance.now() - travel.t0) / 460);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const scale = travel.fromScale + (travel.toScale - travel.fromScale) * e;
      const v = viewRef.current;
      v.scale = scale;
      v.x = travel.fromX + (-(travel.node.x ?? 0) * scale - travel.fromX) * e;
      v.y = travel.fromY + (-(travel.node.y ?? 0) * scale - travel.fromY) * e;
      if (t >= 1) travelRef.current = null;
    }

    const hover = hoverRef.current;
    // Hovering an idea — or a tag in the legend — lifts everything in the same
    // category and pushes the rest back, so a subject can be picked out of
    // the whole map at once.
    const focus =
      legendPinRef.current || legendHoverRef.current || hover?.data.category || null;
    const traced = tracedRef.current;
    const isTraced = (n: Node) => traced !== null && n.data.idea_id === traced;
    const inFocus = (n: Node) =>
      !focus || (n.data.kind === "idea" && n.data.category === focus) || n === hover || isTraced(n);

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
            : link.kind === "category"
              ? C.category
              : C.edge;
      ctx.lineWidth = link.kind === "from" ? 1 : link.kind === "category" ? 1 : 1.6;
      if (link.kind === "related" || link.kind === "contradicts") ctx.setLineDash([4, 4]);
      if (link.kind === "category") ctx.setLineDash([1, 3]);
      ctx.beginPath();
      ctx.moveTo(sa.x, sa.y);
      ctx.lineTo(sb.x, sb.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);
      const r = drawnRadius(n.r, viewRef.current.scale, w);
      ctx.globalAlpha = inFocus(n) ? 1 : 0.22;

      // The same ring the pointer draws, so running down the list of what was
      // taken from a conversation picks each one out on the map in turn.
      if (hover === n || isTraced(n)) {
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

    // Labels last so nothing is drawn over them. Every node gets one — the
    // force simulation's collision radius accounts for label size precisely
    // so that spacing, not skipping, is what keeps them apart.
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    // In a side panel there is no room to name every idea — the labels stack
    // into an unreadable pile. Below a threshold only the conversations are
    // named, plus whatever is being pointed at.
    const compact = ruleset(w).tight;

    // Ideas are not named by default. A map with every title on it is a wall
    // of text; the titles are what you ask for, by pointing at a node, opening
    // one, or pinning a subject in the legend.
    const pinned = legendPinRef.current;
    const revealed = (n: Node) =>
      hover === n ||
      isTraced(n) ||
      focusNodeRef.current === n ||
      revealRef.current.has(n.data.id) ||
      (pinned !== null && n.data.category === pinned);

    const candidates = [...nodesRef.current].sort((a, b) => {
      const rank = (n: Node) => (hover === n ? 0 : n.data.kind === "conversation" ? 1 : n.data.shared ? 2 : 3);
      return rank(a) - rank(b);
    });

    const baseLabelWidth =
      (compact ? 84 : 120) * Math.max(0.6, Math.min(viewRef.current.scale, 2));
    const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const labelPx = (rootPx / 16) * 13;

    // Lay every label out first, then decide whether the set of them fits.
    type Placed = {
      n: Node;
      lines: string[];
      x: number;
      y: number;
      lineHeight: number;
      box: { x0: number; y0: number; x1: number; y1: number };
      isConversation: boolean;
    };
    const laid: Placed[] = [];
    for (const n of candidates) {
      const isConversation = n.data.kind === "conversation";
      if (!isConversation && !revealed(n)) continue;
      if (compact && !isConversation && hover !== n) continue;

      const s = toScreen(n, w, h);
      const r = drawnRadius(n.r, viewRef.current.scale, w);
      // The map draws to a canvas, which the interface-scale setting cannot
      // reach through CSS — read the root font-size directly so map text grows
      // and shrinks with everything else instead of staying fixed.
      ctx.font = isConversation
        ? `600 ${labelPx * 1.04}px ui-sans-serif, system-ui, sans-serif`
        : `${labelPx}px ui-sans-serif, system-ui, sans-serif`;

      // Conversation titles get a wider column and an extra line.
      const maxLabelWidth = isConversation ? baseLabelWidth * 1.4 : baseLabelWidth;
      const lineHeight = labelPx * 1.3;
      const lines = wrapLines(ctx, n.data.label, maxLabelWidth, isConversation ? 5 : 4);
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const box = {
        x0: s.x - widest / 2 - 3,
        x1: s.x + widest / 2 + 3,
        y0: s.y + r + 5,
        y1: s.y + r + 9 + lines.length * lineHeight,
      };
      // Only what is on screen counts, for drawing and for the crowding test
      // below. A title two screens away is not in anyone's way, and letting it
      // vote meant zooming in never uncrowded the map.
      if (box.x1 < 0 || box.x0 > w || box.y1 < 0 || box.y0 > h) continue;
      laid.push({
        n,
        lines,
        x: s.x,
        y: s.y + r + 7,
        lineHeight,
        isConversation,
        box,
      });
    }

    // Zoom out far enough and the titles start landing on top of each other.
    // Rather than dropping whichever one loses — which leaves an arbitrary
    // half of the map named and reads as a bug — they all go at once, and the
    // map falls back to its landmarks. The margin widens while they are
    // hidden, so the two states do not trade places every frame.
    const margin = labelsFitRef.current ? 0 : labelPx * 0.5;
    const grew = (b: Placed["box"]) => ({
      x0: b.x0 - margin,
      y0: b.y0 - margin,
      x1: b.x1 + margin,
      y1: b.y1 + margin,
    });
    let clash = false;
    for (let i = 0; i < laid.length && !clash; i++) {
      for (let j = i + 1; j < laid.length; j++) {
        // Only one idea's title covering another counts. An idea sitting over
        // a conversation's title is fine: whichever of the two is out of focus
        // is dimmed, so the one being looked at still reads — and conversation
        // titles are unavoidable, since an idea orbits the conversation whose
        // name is written directly beneath it.
        if (laid[i].isConversation || laid[j].isConversation) continue;
        const a = grew(laid[i].box);
        const b = grew(laid[j].box);
        if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) {
          clash = true;
          break;
        }
      }
    }
    labelsFitRef.current = !clash;

    for (const l of laid) {
      // Conversations are the map's landmarks and always keep their names, as
      // does whatever is being pointed at directly.
      if (
        !l.isConversation &&
        clash &&
        hover !== l.n &&
        !isTraced(l.n) &&
        focusNodeRef.current !== l.n
      )
        continue;
      ctx.font = l.isConversation
        ? `600 ${labelPx * 1.04}px ui-sans-serif, system-ui, sans-serif`
        : `${labelPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.globalAlpha = inFocus(l.n) ? 1 : 0.2;
      ctx.fillStyle =
        hover === l.n || isTraced(l.n)
          ? C.labelHover
          : l.isConversation
            ? C.labelConversation
            : C.labelIdea;
      l.lines.forEach((line, i) => ctx.fillText(line, l.x, l.y + i * l.lineHeight));
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
    const data = await loadGraph(folder);
    setEmpty(data.nodes.length === 0);

    const colors = categoryColors(data.nodes.map((n) => n.category));
    setLegend([...colors.entries()]);

    const C = paletteRef.current;
    // Reuse positions of nodes that already exist, so re-extraction does not
    // throw the whole map in the air.
    const previous = new Map(nodesRef.current.map((n) => [n.data.id, n]));
    const nodes: Node[] = data.nodes.map((d) => {
      const old = previous.get(d.id);
      const isConversation = d.kind === "conversation";
      return {
        data: d,
        r: isConversation
          ? CONVERSATION_RADIUS + Math.min(12, d.weight * 2)
          : IDEA_RADIUS + Math.min(8, (d.weight - 1) * 4),
        color: isConversation ? C.conversation : colors.get(d.category) ?? UNCATEGORISED,
        labelHalf: estimateLabelHalfWidth(d.label, isConversation),
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
        reasoning: e.reasoning,
      }));

    nodesRef.current = nodes;
    linksRef.current = links;

    // How many ideas orbit each conversation, so a crowded hub can push them
    // further out. A fixed radius left eleven labels only a few pixels of arc
    // apart regardless of how many there were — this is what made dense hubs
    // truncate to almost nothing even with collision avoidance in place.
    const orbitCount = new Map<string, number>();
    for (const l of links) {
      if (l.kind !== "from") continue;
      const sourceId = (l.source as Node).data.id;
      orbitCount.set(sourceId, (orbitCount.get(sourceId) ?? 0) + 1);
    }

    simRef.current?.stop();
    const sim = forceSimulation<Node, Link>(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .id((n) => n.data.id)
          // Ideas sit close to the conversation they came from; a merely related
          // pair is held further apart, so distance means something. The "from"
          // radius grows with how many ideas share that hub, so each one still
          // gets enough arc length for its label.
          .distance((l) => {
            const rules = ruleset(canvasRef.current?.clientWidth ?? 900);
            if (l.kind !== "from") return rules.related;
            const n = orbitCount.get((l.source as Node).data.id) ?? 1;
            return rules.orbit + Math.max(0, n - 4) * rules.orbitGrowth;
          })
          .strength((l) => (l.kind === "from" ? 0.7 : 0.15)),
      )
      // Bigger nodes push harder, so conversations claim their own space.
      .force(
        "charge",
        forceManyBody<Node>().strength((n) => {
          const rules = ruleset(canvasRef.current?.clientWidth ?? 900);
          return rules.charge - n.r * rules.chargeByRadius;
        }),
      )
      // The label hangs below the node rather than around it, so this is an
      // approximation, not a tight fit — but it is what keeps a node with a
      // long title from being crowded before its label ever gets a chance to
      // draw.
      .force(
        "collide",
        forceCollide<Node>().radius((n) => {
          const rules = ruleset(canvasRef.current?.clientWidth ?? 900);
          // Labels are not drawn in a panel, so reserving room for them there
          // only pushes everything apart for nothing.
          return n.r + rules.padding + n.labelHalf * rules.labelShare;
        }),
      )
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
    // Rebuilds when the folder changes: a folder is a separate tree, so the
    // map has to be a different map, not the same one filtered on screen.
  }, [fitToView, folder]);

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
    // Refit whenever the canvas changes size by a meaningful amount, not just
    // once. The map lives in a side panel that can be expanded to fill the
    // pane, and keeping the old framing across that leaves everything in a
    // knot in the middle of a mostly empty canvas.
    let lastW = 0;
    let lastH = 0;
    let settle: number | undefined;
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      if (Math.abs(w - lastW) < 24 && Math.abs(h - lastH) < 24) return;
      lastW = w;
      lastH = h;
      // Debounced: the expand is animated, so this fires every frame of it and
      // refitting mid-transition would fight the animation.
      window.clearTimeout(settle);
      // Crossing between panel and full pane changes the rules, and the
      // forces read them once when they are set — so nudge the simulation
      // hard enough to settle into the new spacing.
      settle = window.setTimeout(() => {
        // d3 caches each force's initialisation, so re-seeding the links
        // makes the distance accessor read the new rules.
        const sim = simRef.current;
        if (sim) {
          const link = sim.force("link") as
            | { links: (l: Link[]) => unknown; initialize?: unknown }
            | undefined;
          if (link && typeof link.links === "function") link.links(linksRef.current);
          sim.alpha(0.8).restart();
        }
        // Opening a file resizes the canvas, and refitting here threw away the
        // framing that opening it had just set up. Re-aim at what is being
        // looked at instead, so it ends up centred in the space that is left.
        const focused = focusNodeRef.current;
        if (focused) {
          const v = viewRef.current;
          travelRef.current = {
            node: focused,
            fromX: v.x,
            fromY: v.y,
            fromScale: v.scale,
            toScale: Math.min(2.2, Math.max(v.scale, 1.15)),
            t0: performance.now(),
          };
        } else {
          fitToView();
        }
      }, 180);
    });
    ro.observe(canvas);
    return () => {
      window.clearTimeout(settle);
      ro.disconnect();
    };
  }, [fitToView]);

  function screenPos(n: Node) {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const s = toScreen(n, canvas.clientWidth, canvas.clientHeight);
    return {
      x: s.x,
      y: s.y,
      r: drawnRadius(n.r, viewRef.current.scale, canvas.clientWidth),
      color: n.color,
      below: s.y > canvas.clientHeight / 2,
    };
  }

  /**
   * Frame a node: travel the view to it, and name it along with everything it
   * touches.
   *
   * The neighbours matter more than the node itself. A conversation is only
   * worth looking at closely to see what came out of it, and an idea to see
   * what it sits next to — so pointing at either one names the whole cluster
   * rather than the single dot you happened to hit.
   */
  function focusOn(n: Node) {
    if (focusNodeRef.current === n) {
      focusNodeRef.current = null;
      revealRef.current = new Set();
      travelRef.current = null;
      return;
    }
    focusNodeRef.current = n;
    const near = new Set<string>([n.data.id]);
    for (const l of linksRef.current) {
      if (l.kind === "category") continue;
      const a = l.source as Node;
      const b = l.target as Node;
      if (a === n) near.add(b.data.id);
      if (b === n) near.add(a.data.id);
    }
    revealRef.current = near;

    const v = viewRef.current;
    travelRef.current = {
      node: n,
      fromX: v.x,
      fromY: v.y,
      fromScale: v.scale,
      // Close enough to read, without throwing away the surroundings. Already
      // closer than that, and the zoom is left where it was.
      toScale: Math.min(2.2, Math.max(v.scale, 1.15)),
      t0: performance.now(),
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
      const drawn = drawnRadius(n.r, viewRef.current.scale, canvas.clientWidth);
      const r = Math.max(drawn + 6, ruleset(canvas.clientWidth).hitRadius);
      const d = Math.hypot(px - s.x, py - s.y);
      if (d <= r && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  /** The nearest correlation or contradiction line, if the click landed close
   *  enough to it — the only edges meant to be clickable. */
  function edgeAt(clientX: number, clientY: number): Link | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    let best: Link | null = null;
    let bestDist = 8;
    for (const link of linksRef.current) {
      if (link.kind !== "related" && link.kind !== "contradicts") continue;
      const a = toScreen(link.source as Node, rect.width, rect.height);
      const b = toScreen(link.target as Node, rect.width, rect.height);
      // Distance from the click to the segment a–b.
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / lenSq));
      const cx = a.x + t * dx;
      const cy = a.y + t * dy;
      const d = Math.hypot(px - cx, py - cy);
      if (d < bestDist) {
        best = link;
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
    <div className={`split${panel && panelSide === "left" ? " panel-left" : ""}`}>
    <div
      className="split-main graph-wrap"
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
          // Any deliberate move of the view takes it over from the animation.
          travelRef.current = null;
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
            // Same threshold the pan branch uses. Marking this moved on any
            // motion event at all meant a click only counted if the pointer
            // held perfectly still between press and release — one pixel of
            // tremor, and opening a node silently did nothing.
            const pan = panRef.current;
            if (pan && Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 2) {
              pan.moved = true;
            }
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

          if (hit !== hoverRef.current) {
            hoverRef.current = hit;
            setHovered(hit?.data ?? null);
            const at = hit ? screenPos(hit) : null;
            setHoverAt(at);
            // The ring, plus the radius of a note circle, plus room to travel.
            keepAliveRef.current = at ? { x: at.x, y: at.y, r: at.r + 62 + 52 } : null;
          }

          // A correlation or contradiction line names how two ideas connect —
          // worth reading on the way past, not worth a click to find out.
          if (hit) {
            if (edgeHover) setEdgeHover(null);
            return;
          }
          const edge = edgeAt(e.clientX, e.clientY);
          if (edge) {
            const rect = canvasRef.current?.getBoundingClientRect();
            setEdgeHover({
              kind: edge.kind as "related" | "contradicts",
              a: (edge.source as Node).data,
              b: (edge.target as Node).data,
              reasoning: edge.reasoning,
              x: rect ? e.clientX - rect.left : 0,
              y: rect ? e.clientY - rect.top : 0,
            });
          } else if (edgeHover) {
            setEdgeHover(null);
          }
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
          if (!hit) {
            // Clicking the bare map puts the titles away again.
            focusNodeRef.current = null;
            revealRef.current = new Set();
            return;
          }
          focusOn(hit);
          if (hit.data.kind === "idea" && hit.data.idea_id !== null)
            openIdea.current(hit.data.idea_id);
          if (hit.data.kind === "conversation" && hit.data.session_id !== null)
            openConversation.current(hit.data.session_id);
        }}
        onWheel={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          travelRef.current = null;
          const rect = canvas.getBoundingClientRect();
          const px = e.clientX - rect.left - rect.width / 2;
          const py = e.clientY - rect.top - rect.height / 2;
          const v = viewRef.current;
          const scale = Math.min(4, Math.max(0.15, v.scale * Math.exp(-e.deltaY * 0.0015)));
          // Pulling back is a way of saying you are done with what you were
          // looking at, the same as clicking away from it. Zooming further in
          // is not — that is still looking.
          if (scale < v.scale && focusNodeRef.current) {
            focusNodeRef.current = null;
            revealRef.current = new Set();
          }
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
            travelRef.current = null;
            focusNodeRef.current = null;
            revealRef.current = new Set();
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
        </div>
      )}

      <div className="graph-key">
        <span className="conv-key">
          <i style={{ background: "var(--accent)" }} /> conversation
        </span>
        {legend.slice(0, 6).map(([name, color]) => (
          <button
            type="button"
            key={name}
            // Hovering previews the highlight; clicking pins it, which is also
            // what puts that subject's titles on the map.
            className={legendPin === name ? "on pinned" : legendFocus === name ? "on" : undefined}
            aria-pressed={legendPin === name}
            onClick={() => {
              const next = legendPin === name ? null : name;
              legendPinRef.current = next;
              setLegendPin(next);
            }}
            onMouseEnter={() => {
              legendHoverRef.current = name;
              setLegendFocus(name);
            }}
            onMouseLeave={() => {
              legendHoverRef.current = null;
              setLegendFocus(null);
            }}
          >
            <i style={{ background: color }} /> {name}
          </button>
        ))}
      </div>

      {edgeHover && (
        <div
          className="relation-popup"
          style={{
            left: edgeHover.x,
            top: edgeHover.y,
          }}
        >
          <div className={`relation-kind ${edgeHover.kind}`}>
            {edgeHover.kind === "contradicts" ? "Contradiction" : "Correlation"}
          </div>
          <div className="relation-side">{edgeHover.a.label}</div>
          <div className="relation-side">{edgeHover.b.label}</div>
          {/* Captured when the pair was judged, not reconstructed now — the
              only moment anything knew. Absent on the older links, and on the
              ones drawn from a similarity score alone. */}
          {edgeHover.reasoning && <div className="relation-why">{edgeHover.reasoning}</div>}
        </div>
      )}

      </div>

      {panel && (
        <FilePanel side={panelSide} onSideChange={setPanelSide} width={panelWidth} onWidthChange={setPanelWidth}>
          {panel.kind === "idea" ? (
            <IdeaFile
              ideaId={panel.id}
              onOpenConversation={(id) => openConversation.current(id)}
              onClose={() => setPanel(null)}
            />
          ) : (
            <ConversationFile
              sessionId={panel.id}
              onOpenIdea={(id) => openIdea.current(id)}
              onTrace={(id) => {
                tracedRef.current = id;
              }}
              onClose={() => setPanel(null)}
            />
          )}
        </FilePanel>
      )}
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
