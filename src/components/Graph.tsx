import { useCallback, useEffect, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { loadGraph, type GraphNode } from "../lib/graph";
import { deleteIdea, onIdeasChanged, reextractSession } from "../lib/ideas";
import { deleteSession, setSessionArchived } from "../lib/chat";
import ContextMenu from "./ContextMenu";
import { categoryColors, UNCATEGORISED } from "../lib/categories";
import { getSettings, onSettingsChanged, type MapStyle } from "../lib/settings";
import { ConversationFile, IdeaFile } from "./Deep";
import FilePanel from "./FilePanel";
import Resolve from "./Resolve";

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
  /** The stored relation, where there is one. Only these can be settled. */
  id?: number;
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
  bubble: string;
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
  const surface = token(st, "--surface-lift", token(st, "--surface", "#221e1a"));
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
    /** Behind the label of whatever is being pointed at, so it stays readable
     *  over links and other labels. Nearly opaque on purpose — a translucent
     *  card over a dense map is the same unreadable label with a tint. */
    bubble: `color-mix(in srgb, ${surface} 94%, transparent)`,
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
/** A node's drawn radius: zoom, clamped, times the size the map is at.
 *  The floor is low — pulled back far enough, a node should read as a dot in
 *  a dense bed, not as a small version of the thing it is at full size. */
function drawnRadius(base: number, scale: number, width: number, style: MapStyle): number {
  return base * Math.max(0.35, Math.min(scale, 2)) * ruleset(width, style).nodeScale;
}

/** What each arrangement multiplies a node's drawn radius by. */
const STYLE_SCALE: Record<MapStyle, number> = {
  nodes: 0.72,
  forest: 0.8,
  galaxy: 0.72,
};

// ---------------------------------------------------------------- placed

/** Where a galaxy's ideas sit, so the draw loop can turn them. */
interface Orbiting {
  node: Node;
  hub: Node;
  /** Distance from the hub it goes round. */
  radius: number;
  /** Where it started, in radians. */
  angle: number;
}

/** Everything an arranged style needs beyond the node positions themselves. */
interface Placed {
  /** Rings to draw, as hub and radius. Galaxy only. */
  rings: { hub: Node; radius: number }[];
  orbits: Orbiting[];
  /** Trunk feet, in world space. Forest only. */
  trunks: { hub: Node; x: number; groundY: number }[];
}

const NOTHING_PLACED: Placed = { rings: [], orbits: [], trunks: [] };

/** The conversation each idea came from, and the ideas each conversation has. */
function hubsAndTheirIdeas(nodes: Node[], links: Link[]) {
  const ideasOf = new Map<Node, Node[]>();
  const hubs = nodes.filter((n) => n.data.kind === "conversation");
  for (const h of hubs) ideasOf.set(h, []);
  const loose: Node[] = [];
  const claimed = new Set<Node>();
  for (const l of links) {
    if (l.kind !== "from") continue;
    const hub = l.source as Node;
    const idea = l.target as Node;
    if (!ideasOf.has(hub)) continue;
    ideasOf.get(hub)!.push(idea);
    claimed.add(idea);
  }
  // An idea whose conversation was deleted still has to go somewhere: the map
  // shows everything, and a node with nowhere to be is a node that vanishes.
  for (const n of nodes) {
    if (n.data.kind !== "conversation" && !claimed.has(n)) loose.push(n);
  }
  return { hubs, ideasOf, loose };
}

/**
 * Ideas that link to one another, grouped.
 *
 * A galaxy's rings are these groups: a ring is a set of thoughts that belong
 * together, so two ideas joined by a relation share an orbit rather than
 * sitting at unrelated distances from the same centre.
 */
function ringsOf(ideas: Node[], links: Link[]): Node[][] {
  const index = new Map(ideas.map((n, i) => [n, i]));
  const parent = ideas.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const l of links) {
    if (l.kind === "from") continue;
    const a = index.get(l.source as Node);
    const b = index.get(l.target as Node);
    if (a === undefined || b === undefined) continue;
    parent[find(a)] = find(b);
  }
  const groups = new Map<number, Node[]>();
  ideas.forEach((n, i) => {
    const key = find(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  });
  // Ideas that belong together get a ring of their own; everything unlinked
  // shares the outer ones. Giving each lone idea its own ring put six ideas on
  // six radii at almost the same angle — a spiral arm, not a galaxy.
  const together = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  const alone = [...groups.values()].filter((g) => g.length === 1).flat();

  const rings = [...together];
  // Split the loose ones when there are more than a ring can hold without
  // their labels running into each other.
  const PER_RING = 9;
  for (let i = 0; i < alone.length; i += PER_RING) {
    rings.push(alone.slice(i, i + PER_RING));
  }
  return rings;
}

/** Ideas in orbit around the conversation they came from. */
function arrangeGalaxy(nodes: Node[], links: Link[]): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed: Placed = { rings: [], orbits: [], trunks: [] };

  hubs.forEach((hub, i) => {
    // A golden-angle spiral: galaxies do not sit on a grid, and this spaces
    // them without any two landing at the same distance and angle. The first
    // sits at the centre rather than a step out along the arm, so a folder
    // with one or two conversations is not framed around an empty middle.
    const away = i === 0 ? 0 : 430 * Math.sqrt(i);
    const around = i * 2.399963;
    hub.x = Math.cos(around) * away;
    hub.y = Math.sin(around) * away;
    hub.fx = hub.x;
    hub.fy = hub.y;

    ringsOf(ideasOf.get(hub) ?? [], links).forEach((ring, r) => {
      const radius = 96 + r * 62;
      placed.rings.push({ hub, radius });
      ring.forEach((idea, k) => {
        // Offset per ring so neighbouring orbits do not line their nodes up
        // into spokes.
        const angle = (k / ring.length) * Math.PI * 2 + r * 1.1;
        placed.orbits.push({ node: idea, hub, radius, angle });
      });
    });
  });

  loose.forEach((n, i) => {
    const away = 260 + i * 40;
    n.x = Math.cos(i * 2.399963) * away;
    n.y = Math.sin(i * 2.399963) * away;
    n.fx = n.x;
    n.fy = n.y;
  });
  return placed;
}

/** A tree per conversation, its ideas the roots beneath it. */
function arrangeForest(nodes: Node[], links: Link[]): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed: Placed = { rings: [], orbits: [], trunks: [] };
  const GROUND = 0;
  const TRUNK = 160;
  const PER_LEVEL = 3;
  const ROOT_STEP = 92;
  /** How far a root reaches sideways at the deepest level it goes to. */
  const reach = (level: number) => 70 + level * 52;

  // Wide enough that the deepest roots of one tree clear the next tree's.
  // A fixed gap meant two full root systems nearly touching, which read as
  // one tangle rather than two trees.
  const deepest = Math.max(
    1,
    ...hubs.map((h) => Math.ceil((ideasOf.get(h)?.length ?? 0) / PER_LEVEL)),
  );
  const spacing = reach(deepest) * 2 + 120;

  hubs.forEach((hub, i) => {
    const x = (i - (hubs.length - 1) / 2) * spacing;
    hub.x = x;
    hub.y = GROUND - TRUNK;
    hub.fx = hub.x;
    hub.fy = hub.y;
    placed.trunks.push({ hub, x, groundY: GROUND });

    // Roots: each level fans wider and sits deeper, so the whole thing reads
    // downward from the trunk rather than as a second crown.
    const ideas = ideasOf.get(hub) ?? [];
    ideas.forEach((idea, k) => {
      const level = Math.floor(k / PER_LEVEL) + 1;
      // How many share this level — the last one is usually short.
      const inLevel = Math.min(PER_LEVEL, ideas.length - (level - 1) * PER_LEVEL);
      const slot = k % PER_LEVEL;
      const width = reach(level);
      const across = inLevel === 1 ? 0 : (slot / (inLevel - 1) - 0.5) * 2 * width;
      idea.x = x + across;
      idea.y = GROUND + level * ROOT_STEP;
      idea.fx = idea.x;
      idea.fy = idea.y;
    });
  });

  loose.forEach((n, i) => {
    n.x = (i - (loose.length - 1) / 2) * 120;
    n.y = GROUND + 320;
    n.fx = n.x;
    n.fy = n.y;
  });
  return placed;
}

function ruleset(width: number, style: MapStyle = "forest") {
  const tight = width < 560;
  return {
    tight,
    /** Orbit radius around a conversation. */
    orbit: tight ? 56 : 150,
    orbitGrowth: tight ? 6 : 20,
    /** How far a merely related pair sits apart. */
    related: tight ? 100 : 280,
    /** Space reserved around a node, label included. */
    padding: tight ? 6 : 26,
    /** A label's share of that space. Almost none when labels are hidden. */
    labelShare: tight ? 0.15 : 1,
    /** Fitts's law, but a crowded panel needs a smaller target or every
     *  click lands on a neighbour. */
    hitRadius: tight ? 11 : 16,
    /** Nodes are drawn smaller in a panel; at full size they crowd it out.
     *  The full-page map used to take the roomy figure straight, which on a
     *  wide canvas is a field of circles with the links lost between them —
     *  so the chosen style scales it rather than the panel alone deciding. */
    nodeScale: (tight ? 0.62 : 1) * STYLE_SCALE[style],
    charge: tight ? -18 : -85,
    chargeByRadius: tight ? 4 : 12,
  };
}

export default function Graph({
  folder,
  onOpenFile,
}: {
  folder: number | null;
  /**
   * Open a node's file over the whole app instead of in the map's own side
   * panel. Passed when the map itself is confined to a small pane — inside
   * the advanced layout's workspace — where a second panel opening within
   * that pane has nowhere to be but cramped. Full-page map keeps its own
   * side panel, which has room to be one.
   */
  onOpenFile?: (kind: "idea" | "conversation", id: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paletteRef = useRef<Palette>(readPalette());
  const nodesRef = useRef<Node[]>([]);
  const linksRef = useRef<Link[]>([]);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  /** The zoom the whole map was framed at. Spacing is measured against it:
   *  at the fit zoom the map is itself, zooming in spreads it further apart
   *  than the zoom alone would, and zooming out pulls it in tighter. */
  const fitScaleRef = useRef(1);
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
  const travelRef = useRef<{
    node: Node;
    fromX: number;
    fromY: number;
    fromScale: number;
    toScale: number;
    /** Where the node was when the travel began, in world units. */
    toX: number;
    toY: number;
    t0: number;
  } | null>(null);
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
  /** Held in a ref rather than state: the draw loop and the hit test both read
   *  it every frame, and a re-render per frame is not the way to tell them. */
  const styleRef = useRef<MapStyle>("forest");
  /** What an arranged style worked out: rings to draw, orbits to turn,
   *  trunks to stand. Empty under `nodes`, which is laid out by force. */
  const placedRef = useRef<Placed>(NOTHING_PLACED);
  const [, restyle] = useState(0);
  // Held in a ref rather than state because the draw loop and the hit test
  // read it every frame; the counter is only to get one render out of a
  // change. `buildRef` because rebuilding is what a style change means — the
  // three are different arrangements, not different paint.
  const buildRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const apply = (m: MapStyle) => {
      if (!alive || m === styleRef.current) return;
      styleRef.current = m;
      restyle((n) => n + 1);
      buildRef.current();
    };
    // The first read is not a change, so it sets the ref and rebuilds once —
    // the initial build may already have run under the default.
    void getSettings().then((st) => {
      if (!alive) return;
      if (st.map_style !== styleRef.current) apply(st.map_style);
    });
    const un = onSettingsChanged((st) => apply(st.map_style));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  // Opening a node's file happens over the map, not instead of it — clicking
  // the same node again closes it, clicking a different one swaps the panel's
  // content, rather than navigating away and losing the map's state.
  const [panel, setPanel] = useState<{ kind: "idea" | "conversation"; id: number } | null>(null);
  /** A node right-clicked on the map, and where. */
  const [menu, setMenu] = useState<{ x: number; y: number; node: GraphNode } | null>(null);
  /** The open file, readable from the canvas handlers without making them
   *  depend on a re-render. */
  const panelRef = useRef(panel);
  panelRef.current = panel;
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
  /** A contradiction the person has clicked, to settle it. Hovering explains
   *  the tension; clicking is where something can be done about it. */
  const [resolving, setResolving] = useState<{
    relationId: number;
    a: { idea_id: number; claim: string };
    b: { idea_id: number; claim: string };
    reasoning?: string;
  } | null>(null);
  /** Following a link out of an idea's file to the conversation it came from,
   *  which swaps the panel rather than stacking. */
  const openConversation = useRef((id: number) => {
    if (onOpenFile) {
      onOpenFile("conversation", id);
      return;
    }
    setPanel((p) => (p?.kind === "conversation" && p.id === id ? null : { kind: "conversation", id }));
  });
  useEffect(() => {
    openConversation.current = (id: number) => {
      if (onOpenFile) {
        onOpenFile("conversation", id);
        return;
      }
      setPanel((p) => (p?.kind === "conversation" && p.id === id ? null : { kind: "conversation", id }));
    };
  }, [onOpenFile]);

  /**
   * Spacing breathes with the zoom.
   *
   * Node size is clamped on screen, so zooming in already leaves air and
   * zooming out crowds — but not enough, and not in the right proportion.
   * Offsets from the layout's centre get a factor on top of the zoom: past
   * the fit zoom the map spreads further apart than the zoom alone would
   * (labels get room before they start colliding), pulled back it draws in
   * tighter (a pulled-back map should read as one dense thing, not as small
   * nodes swimming apart). Bounded, and 1 at the fit zoom, so the framing
   * computation stays exact there.
   */
  function spreadOf(scale: number): number {
    const fit = fitScaleRef.current || 1;
    return Math.min(2.1, Math.max(0.75, Math.pow(scale / fit, 0.5)));
  }

  const toScreen = useCallback((n: { x?: number; y?: number }, w: number, h: number) => {
    const v = viewRef.current;
    const spread = spreadOf(v.scale);
    return {
      x: (n.x ?? 0) * v.scale * spread + v.x + w / 2,
      y: (n.y ?? 0) * v.scale * spread + v.y + h / 2,
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
      const spread = spreadOf(scale);
      // Aimed at where the node was when it was clicked, not at where it is
      // this frame. Re-aiming every frame chased a target the simulation was
      // still moving, and easing toward a moving point oscillates — which is
      // what the shaking was. The node is pinned for the duration instead, so
      // the destination and the thing at it agree.
      v.x = travel.fromX + (-travel.toX * scale * spread - travel.fromX) * e;
      v.y = travel.fromY + (-travel.toY * scale * spread - travel.fromY) * e;
      if (t >= 1) {
        travel.node.fx = null;
        travel.node.fy = null;
        travelRef.current = null;
      }
    }

    const hover = hoverRef.current;
    // Hovering an idea — or a tag in the legend — lifts everything in the same
    // category and pushes the rest back, so a subject can be picked out of
    // the whole map at once.
    const focus =
      legendPinRef.current || legendHoverRef.current || hover?.data.category || null;
    // A galaxy turns. Inner rings go round faster than outer ones, which is
    // what a galaxy actually does and what keeps the rings legible as rings
    // rather than as a wheel of spokes.
    const placed = placedRef.current;
    if (styleRef.current === "galaxy" && placed.orbits.length) {
      const t = performance.now() / 1000;
      for (const o of placed.orbits) {
        // Slow. A galaxy that visibly races is a loading spinner; this should
        // read as drift you notice only if you watch for it.
        const angle = o.angle + (t * 7) / o.radius;
        o.node.x = (o.hub.x ?? 0) + Math.cos(angle) * o.radius;
        o.node.y = (o.hub.y ?? 0) + Math.sin(angle) * o.radius;
        o.node.fx = o.node.x;
        o.node.fy = o.node.y;
      }
    }

    // The rings themselves, faint, so a shared orbit reads as one thing.
    if (styleRef.current === "galaxy") {
      ctx.strokeStyle = C.related;
      ctx.globalAlpha = 0.14;
      ctx.lineWidth = 1;
      for (const ring of placed.rings) {
        const centre = toScreen(ring.hub, w, h);
        const r = ring.radius * viewRef.current.scale * spreadOf(viewRef.current.scale);
        if (r < 2 || r > 4000) continue;
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Ground and trunks. Drawn before the branches so the roots below it read
    // as going into the ground rather than sitting on top of a line.
    if (styleRef.current === "forest" && placed.trunks.length) {
      const k = viewRef.current.scale * spreadOf(viewRef.current.scale);
      const ground = toScreen({ x: 0, y: 0 }, w, h).y;
      ctx.strokeStyle = C.related;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ground);
      ctx.lineTo(w, ground);
      ctx.stroke();
      ctx.globalAlpha = 1;

      for (const trunk of placed.trunks) {
        const crown = toScreen(trunk.hub, w, h);
        const foot = toScreen({ x: trunk.x, y: trunk.groundY }, w, h);

        // Branches. Without them a tree is a circle on a stick — the roots
        // below say "tree" and nothing above ground agreed. Drawn from the
        // conversation's own colour, thinning outward, and fanned upward so
        // the canopy sits over the trunk rather than beside it.
        ctx.strokeStyle = trunk.hub.color;
        ctx.globalAlpha = 0.5;
        ctx.lineCap = "round";
        const span = Math.max(10, 74 * k);
        for (const [lean, rise, weight] of [
          [-0.85, 0.75, 1],
          [-0.45, 1.05, 0.8],
          [0.0, 1.2, 0.9],
          [0.45, 1.05, 0.8],
          [0.85, 0.75, 1],
        ] as [number, number, number][]) {
          ctx.lineWidth = Math.max(0.7, 2.4 * k * weight);
          ctx.beginPath();
          ctx.moveTo(crown.x, crown.y);
          ctx.quadraticCurveTo(
            crown.x + lean * span * 0.5,
            crown.y - rise * span * 0.5,
            crown.x + lean * span,
            crown.y - rise * span,
          );
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // Tapered: wide at the ground, narrow at the crown, the same shape the
        // branches use so a tree is one drawing rather than two.
        const wide = Math.max(1.2, 7 * k);
        const thin = Math.max(0.8, 2.6 * k);
        ctx.fillStyle = trunk.hub.color;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.moveTo(foot.x - wide, foot.y);
        ctx.lineTo(foot.x + wide, foot.y);
        ctx.lineTo(crown.x + thin, crown.y);
        ctx.lineTo(crown.x - thin, crown.y);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    const traced = tracedRef.current;
    const isTraced = (n: Node) => traced !== null && n.data.idea_id === traced;
    const inFocus = (n: Node) =>
      !focus || (n.data.kind === "idea" && n.data.category === focus) || n === hover || isTraced(n);

    for (const link of linksRef.current) {
      const a = link.source as Node;
      const b = link.target as Node;
      // In a galaxy the ring says which conversation an idea belongs to, so
      // drawing the join as well turns every hub into a wheel of spokes —
      // which is the one shape a galaxy is not.
      if (styleRef.current === "galaxy" && link.kind === "from") continue;
      // In a forest a root leaves the foot of the trunk, not the crown. Drawn
      // from the node itself, every root ran the length of the trunk and out
      // through the top of the tree.
      const sa =
        styleRef.current === "forest" && link.kind === "from"
          ? toScreen({ x: a.x, y: 0 }, w, h)
          : toScreen(a, w, h);
      const sb = toScreen(b, w, h);
      const lit = !focus || inFocus(a) || inFocus(b);
      ctx.globalAlpha = lit ? 1 : 0.18;

      if (link.kind === "from") {
        // A branch, not a line: tapered and bowed slightly off the straight
        // join, thick where it leaves the conversation and thin where it
        // arrives at the idea, shaded from the root's colour to the idea's.
        // The bend is signed per pair so a branch keeps its side as the
        // simulation moves rather than snapping across.
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          const nx = -dy / len;
          const ny = dx / len;
          const side = a.data.id < b.data.id ? 1 : -1;
          const bend = Math.min(26, len * 0.16) * side;
          const cx = (sa.x + sb.x) / 2 + nx * bend;
          const cy = (sa.y + sb.y) / 2 + ny * bend;
          const sizeW = Math.max(0.55, Math.min(2, viewRef.current.scale));
          const rootW = 2.4 * sizeW * (ruleset(w).tight ? 0.7 : 1);
          const tipW = 0.55 * sizeW;
          const midW = (rootW + tipW) / 2;
          const grad = ctx.createLinearGradient(sa.x, sa.y, sb.x, sb.y);
          grad.addColorStop(0, a.color);
          grad.addColorStop(1, b.color);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(sa.x + nx * rootW, sa.y + ny * rootW);
          ctx.quadraticCurveTo(cx + nx * midW, cy + ny * midW, sb.x + nx * tipW, sb.y + ny * tipW);
          ctx.lineTo(sb.x - nx * tipW, sb.y - ny * tipW);
          ctx.quadraticCurveTo(cx - nx * midW, cy - ny * midW, sa.x - nx * rootW, sa.y - ny * rootW);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        ctx.strokeStyle =
          link.kind === "contradicts"
            ? C.contradicts
            : link.kind === "related"
              ? C.related
              : C.category;
        ctx.lineWidth = link.kind === "category" ? 1 : 1.6;
        if (link.kind === "related" || link.kind === "contradicts") ctx.setLineDash([4, 4]);
        if (link.kind === "category") ctx.setLineDash([1, 3]);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.globalAlpha = 1;

    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);
      const r = drawnRadius(n.r, viewRef.current.scale, w, styleRef.current);
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
      const r = drawnRadius(n.r, viewRef.current.scale, w, styleRef.current);
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
    const overlaps = (a: Placed["box"], b: Placed["box"]) =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    /** Conversation labels already committed this frame, in compact mode. */
    const drawn: Placed["box"][] = [];
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
      const mustDraw = hover === l.n || isTraced(l.n) || focusNodeRef.current === l.n;
      if (!l.isConversation && !mustDraw && clash) continue;
      // Conversations keep their names at full size — they are the map's
      // landmarks, and all-or-nothing there leaves an unlabelled map. In a
      // panel narrow enough for compact mode they cannot all fit, so they
      // yield one at a time to whatever was drawn before them: four names and
      // two bare dots beats six names on top of each other.
      if (l.isConversation && compact && !mustDraw) {
        if (drawn.some((b) => overlaps(b, l.box))) continue;
        drawn.push(l.box);
      }
      ctx.font = l.isConversation
        ? `600 ${labelPx * 1.04}px ui-sans-serif, system-ui, sans-serif`
        : `${labelPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.globalAlpha = inFocus(l.n) ? 1 : 0.2;

      // What is being pointed at gets a bubble under it. On a dense map a
      // label lands on top of links and other labels and becomes unreadable
      // exactly when it is being read — this puts a card behind the one that
      // matters, so it is legible whatever it is over.
      if (hover === l.n) {
        const pad = Math.max(3, labelPx * 0.42);
        const widest = Math.max(...l.lines.map((line) => ctx.measureText(line).width));
        const boxH = l.lines.length * l.lineHeight + pad * 1.4;
        const boxW = widest + pad * 2;
        const bx = l.x - boxW / 2;
        const by = l.y - l.lineHeight * 0.82 - pad * 0.7;
        const r = Math.min(7, pad * 1.5);
        const was = ctx.globalAlpha;
        ctx.globalAlpha = 1;
        ctx.fillStyle = C.bubble;
        ctx.beginPath();
        ctx.roundRect(bx, by, boxW, boxH, r);
        ctx.fill();
        ctx.strokeStyle = l.n.color;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = was;
      }
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

    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    // Room for the biggest node and the title under it, in screen pixels —
    // which is where both are actually drawn. The pad is a world-space
    // number, so it depends on the scale, and the scale depends on the pad:
    // three passes land it. (A single pass in world units clipped the map's
    // top whenever the fit zoom came out above one — the drawn node was
    // bigger than the world-space pad had budgeted.)
    const maxR = Math.max(...nodes.map((n) => n.r));
    let pad = maxR + 12;
    let scale = 1;
    for (let i = 0; i < 3; i++) {
      const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2);
      const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2);
      scale = Math.min(w * 0.94 / spanX, h * 0.94 / spanY, 3.2);
      pad = (maxR * Math.min(2, Math.max(0.35, scale))) / scale + 34 / scale;
    }
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    // A margin that is a share of the canvas rather than a fixed number of
    // pixels, so the framing looks the same whatever size the window is.
    fitScaleRef.current = scale;
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
        id: e.id,
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

    // Forest and Galaxy are arrangements, not forces: where a node goes is
    // decided outright, so there is nothing for a simulation to settle. Pinned
    // rather than merely positioned, so dragging one puts it back rather than
    // leaving a tree with a branch wandering off.
    if (styleRef.current !== "nodes") {
      placedRef.current =
        styleRef.current === "forest" ? arrangeForest(nodes, links) : arrangeGalaxy(nodes, links);
      simRef.current = null;
      fitToView();
      return;
    }
    placedRef.current = NOTHING_PLACED;
    for (const n of nodes) {
      n.fx = null;
      n.fy = null;
    }

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
            const rules = ruleset(planWidth());
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
          const rules = ruleset(planWidth());
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
          const rules = ruleset(planWidth());
          // Labels are not drawn in a panel, so reserving room for them there
          // only pushes everything apart for nothing.
          return n.r + rules.padding + n.labelHalf * rules.labelShare;
        }),
      )
      // Strong enough to hold the map around the origin, so the initial framing
      // stays valid as the simulation keeps moving. Too weak and it slowly
      // wanders out of view while you watch it.
      .force("center", forceCenter(0, 0).strength(0.25))
      // Ideas only link back to the conversations they came from, so anything
      // disconnected from the rest — a conversation whose ideas nobody
      // returned to — feels no pull but the charge's push, and given enough
      // ticks flies off on its own. A gentle spring to the origin per axis
      // holds every component in one map while leaving the local shape to the
      // links; forceCenter alone translates the centroid and cannot do this.
      .force("x", forceX(0).strength(0.06))
      .force("y", forceY(0).strength(0.06))
      .alphaDecay(0.02)
      // Never freezes completely: a nudge keeps it alive enough to respond to a
      // drag without needing to be woken up.
      .alphaMin(0.001)
      .velocityDecay(0.35);

    simRef.current = sim;
    sim.alpha(1).restart();

    // Let it find its shape before framing, or the first fit captures the
    // initial scatter and everything drifts out of view afterwards. A fixed
    // tick count was not enough: with alphaDecay at 0.02, 120 ticks leave
    // alpha near 0.09 and the map kept drifting for seconds after the fit —
    // the frame captured a mid-flight state, and the settled map sat
    // off-centre in it. Ticking to the simulation's own minimum makes the
    // frame final.
    let guard = 0;
    while (sim.alpha() > sim.alphaMin() && guard++ < 600) sim.tick();
    fitToView();
    // Rebuilds when the folder changes: a folder is a separate tree, so the
    // map has to be a different map, not the same one filtered on screen.
  }, [fitToView, folder]);

  useEffect(() => {
    buildRef.current = () => void build();
  }, [build]);

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
        // d3 precomputes every force's per-node values once, in `initialize`,
        // so an accessor that reads the rules is only consulted then. Re-seeding
        // the links made the *distance* accessor read the new rules — and left
        // collision radii and charge strengths at whatever was computed the
        // first time, which for a panel still hidden was the cramped set. That
        // is what packed the full-page map together: padding of six and no room
        // reserved for labels at all.
        //
        // Re-setting an accessor is how you ask d3 to initialise again; the
        // functions are the same ones, they just have to be handed back.
        const sim = simRef.current;
        if (sim) {
          const link = sim.force("link") as
            | { links: (l: Link[]) => unknown; initialize?: unknown }
            | undefined;
          if (link && typeof link.links === "function") link.links(linksRef.current);

          const collide = sim.force("collide") as
            | { radius: (f: (n: Node) => number) => unknown }
            | undefined;
          if (collide && typeof collide.radius === "function") {
            collide.radius((n: Node) => {
              const rules = ruleset(planWidth());
              return n.r + rules.padding + n.labelHalf * rules.labelShare;
            });
          }

          const charge = sim.force("charge") as
            | { strength: (f: (n: Node) => number) => unknown }
            | undefined;
          if (charge && typeof charge.strength === "function") {
            charge.strength((n: Node) => {
              const rules = ruleset(planWidth());
              return rules.charge - n.r * rules.chargeByRadius;
            });
          }

          sim.alpha(0.8).restart();
          // Tick the restart out to its own minimum before fitting — the same
          // discipline the first build runs. Leaving the simulation to drift
          // after the fit let the map wander out of the frame that had just
          // been computed for it, and branches ended up pointing at nodes
          // that were no longer where the frame said.
          let guard = 0;
          while (sim.alpha() > sim.alphaMin() && guard++ < 600) sim.tick();
        }
        // Opening a file resizes the canvas, and refitting here threw away the
        // framing that opening it had just set up. Re-aim at what is being
        // looked at instead, so it ends up centred in the space that is left.
        const focused = focusNodeRef.current;
        if (focused) travelTo(focused);
        else fitToView();
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
      r: drawnRadius(n.r, viewRef.current.scale, canvas.clientWidth, styleRef.current),
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
      cancelTravel();
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

    travelTo(n);
  }

  /** Stop a flight in progress, releasing whatever it had pinned. */
  function cancelTravel() {
    const travel = travelRef.current;
    if (!travel) return;
    travel.node.fx = null;
    travel.node.fy = null;
    travelRef.current = null;
  }

  /** Fly the view to a node and hold it still while doing so. */
  function travelTo(n: Node) {
    const v = viewRef.current;
    // Pinned for the flight. Without this the node drifts under the simulation
    // while the view is moving toward it, and the whole map appears to shake.
    n.fx = n.x ?? 0;
    n.fy = n.y ?? 0;
    travelRef.current = {
      node: n,
      fromX: v.x,
      fromY: v.y,
      fromScale: v.scale,
      // Close enough to read, without throwing away the surroundings. Already
      // closer than that, and the zoom is left where it was.
      toScale: Math.min(2.2, Math.max(v.scale, 1.15)),
      toX: n.fx,
      toY: n.fy,
      t0: performance.now(),
    };
  }

  /**
   * The width to plan the layout against.
   *
   * `clientWidth` is 0 whenever the panel is hidden — which in the simple
   * layout is most of the time, since only one place is on screen at once.
   * Zero is not a narrow panel, it is no measurement at all, and the forces
   * read `width < 560` as "cramped side panel": orbits of 56 instead of 150,
   * six pixels of padding instead of twenty-six. Ideas usually arrive while
   * you are still on Think, so the full-page map was routinely laid out with
   * the spacing meant for a column, and everything sat on top of everything.
   */
  function planWidth(): number {
    const w = canvasRef.current?.clientWidth ?? 0;
    return w > 0 ? w : 900;
  }

  function nodeAt(clientX: number, clientY: number): Node | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    // `clientWidth`, not `rect.width`, because that is what `draw` projects
    // through. They agree today and would quietly stop agreeing the moment
    // the canvas gained a border.
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    let best: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);
      const drawn = drawnRadius(n.r, viewRef.current.scale, canvas.clientWidth, styleRef.current);
      const r = Math.max(drawn + 6, ruleset(canvas.clientWidth, styleRef.current).hitRadius);
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
      const a = toScreen(link.source as Node, canvas.clientWidth, canvas.clientHeight);
      const b = toScreen(link.target as Node, canvas.clientWidth, canvas.clientHeight);
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
  /// The inverse of `toScreen`, and it has to be exactly that.
  ///
  /// It divided by `scale` alone while `toScreen` multiplies by
  /// `scale * spread`, so the two were only inverses at the one zoom where
  /// spread happens to be 1. Everywhere else, grabbing a node teleported it
  /// somewhere near the cursor and then moved it at the wrong rate — which
  /// reads as the map not knowing what you are pointing at.
  function toWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    const k = v.scale * spreadOf(v.scale);
    return {
      x: (clientX - rect.left - rect.width / 2 - v.x) / k,
      y: (clientY - rect.top - rect.height / 2 - v.y) / k,
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
        setEdgeHover(null);
      }}
    >
      <canvas
        ref={canvasRef}
        className="graph"
        onMouseDown={(e) => {
          // Any deliberate move of the view takes it over from the animation.
          cancelTravel();
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
            // A contradiction is the one edge worth clicking: it is the only
            // thing on the map that asks the person a question. Checked before
            // the map is cleared, or the click would only ever dismiss labels.
            const edge = edgeAt(e.clientX, e.clientY);
            if (edge && edge.kind === "contradicts" && edge.id !== undefined) {
              const a = (edge.source as Node).data;
              const b = (edge.target as Node).data;
              if (a.idea_id !== null && b.idea_id !== null) {
                setEdgeHover(null);
                setResolving({
                  relationId: edge.id,
                  a: { idea_id: a.idea_id, claim: a.label },
                  b: { idea_id: b.idea_id, claim: b.label },
                  reasoning: edge.reasoning,
                });
                return;
              }
            }
            // Clicking the bare map puts the titles away again.
            focusNodeRef.current = null;
            revealRef.current = new Set();
            return;
          }
          // The file and the framing are one thing. A node whose file is
          // already open closes it and stays where it is — flying the map
          // somewhere while taking away what you were reading is the worst of
          // both. Anything else opens and travels together.
          const id = hit.data.kind === "idea" ? hit.data.idea_id : hit.data.session_id;
          if (id === null) return;
          const kind = hit.data.kind === "idea" ? "idea" : "conversation";
          if (onOpenFile) {
            focusOn(hit);
            onOpenFile(kind, id);
            return;
          }
          if (panelRef.current?.kind === kind && panelRef.current.id === id) {
            focusNodeRef.current = null;
            revealRef.current = new Set();
            cancelTravel();
            setPanel(null);
            return;
          }
          focusOn(hit);
          setPanel({ kind, id });
        }}
        onContextMenu={(e) => {
          // The map's own menu, not the browser's — and only over a node,
          // since there is nothing to do to empty canvas.
          e.preventDefault();
          const hit = nodeAt(e.clientX, e.clientY);
          if (!hit) return;
          setMenu({ x: e.clientX, y: e.clientY, node: hit.data });
        }}
        onWheel={(e) => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          cancelTravel();
          const rect = canvas.getBoundingClientRect();
          const px = e.clientX - rect.left - rect.width / 2;
          const py = e.clientY - rect.top - rect.height / 2;
          const v = viewRef.current;
          const scale = Math.min(4, Math.max(0.15, v.scale * Math.exp(-e.deltaY * 0.0015)));
          // Pulling back is a way of saying you are done with what you were
          // looking at, the same as clicking away from it. Zooming further in
          // is not — that is still looking. Neither is pulling back while a
          // file is open: that is reading one thing and glancing at where it
          // sits, and dropping the focus there would leave the open file with
          // nothing lit on the map.
          if (scale < v.scale && focusNodeRef.current && !panelRef.current) {
            focusNodeRef.current = null;
            revealRef.current = new Set();
          }
          // The spread rides along: what stays under the cursor is the point
          // as it is actually drawn, spread and all.
          const k =
            (scale * spreadOf(scale)) / (v.scale * spreadOf(v.scale));
          v.x = px - (px - v.x) * k;
          v.y = py - (py - v.y) * k;
          v.scale = scale;
        }}
      />

      {!empty && (
        <button
          className="graph-reset"
          onClick={() => {
            cancelTravel();
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

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.node.kind === "conversation" && menu.node.session_id !== null
              ? [
                  {
                    // Cheap and reversible, so it goes without asking.
                    label: "Archive it",
                    onSelect: () =>
                      void setSessionArchived(menu.node.session_id!, true).then(() => build()),
                  },
                  {
                    label: "Read it again",
                    confirm: "Yes, read it again",
                    onSelect: () =>
                      void reextractSession(menu.node.session_id!).then(() => build()),
                  },
                  {
                    label: "Delete it",
                    danger: true,
                    confirm: "Yes, delete it",
                    onSelect: () =>
                      void deleteSession(menu.node.session_id!).then(() => {
                        setPanel(null);
                        void build();
                      }),
                  },
                ]
              : [
                  {
                    label: "Delete this idea",
                    danger: true,
                    confirm: "Yes, delete it",
                    onSelect: () => {
                      if (menu.node.idea_id === null) return;
                      void deleteIdea(menu.node.idea_id).then(() => {
                        setPanel(null);
                        void build();
                      });
                    },
                  },
                ]
          }
        />
      )}

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
          {/* Otherwise the line is only ever a complaint. Said here because
              this is the moment somebody is looking at it. */}
          {edgeHover.kind === "contradicts" && (
            <div className="relation-do">Click to settle it</div>
          )}
        </div>
      )}

      {resolving && (
        <Resolve
          a={resolving.a}
          b={resolving.b}
          relationId={resolving.relationId}
          reasoning={resolving.reasoning}
          onClose={() => setResolving(null)}
          onChanged={() => void build()}
        />
      )}

      </div>

      {!onOpenFile && panel && (
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
