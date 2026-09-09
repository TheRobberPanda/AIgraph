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
import {
  getSettings,
  onSettingsChanged,
  saveSettings,
  MAP_SPREADS,
  MAP_STYLES,
  type MapSpread,
  type MapStyle,
} from "../lib/settings";
import { ConversationFile, IdeaFile } from "./Deep";
import FilePanel from "./FilePanel";
import Resolve from "./Resolve";
import { IconFit, IconZoomIn, IconZoomOut } from "./Icons";

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
  trunks: { hub: Node; x: number; groundY: number; deepestY: number }[];
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
  // Moons are the exception — they are placed against their planet after the
  // arrangement has run, so they must not be given a place of their own here.
  for (const n of nodes) {
    if (n.data.kind === "conversation" || n.data.kind === "moon") continue;
    if (!claimed.has(n)) loose.push(n);
  }
  return { hubs, ideasOf, loose };
}

/** A moon and the planet it keeps station on. */
interface Moon {
  node: Node;
  planet: Node;
  angle: number;
  away: number;
}

/**
 * Work out where every moon sits relative to the idea it answers.
 *
 * A moon has no conversation of its own, so each of the three layouts would
 * have to learn what one is — and each would find a different wrong place to
 * put it. Instead this is the one rule true in all three: an answer sits
 * beside the claim it defends, close enough that nothing comes between them.
 * Which is a *relative* position, so it is worked out once here and applied
 * every frame — a galaxy's planets are still turning, and a force layout's
 * are still settling.
 *
 * Above and to the right, fanning as they multiply. Above, because ideas fan
 * downward in the forest and outward in the galaxy, and a moon underneath
 * would land in the next thing along.
 */
function moonsOf(nodes: Node[]): Moon[] {
  const byIdea = new Map<number, Node>();
  for (const n of nodes) {
    if (n.data.kind === "idea" && n.data.idea_id !== null) byIdea.set(n.data.idea_id, n);
  }
  const counted = new Map<Node, number>();
  const moons: Moon[] = [];
  for (const n of nodes) {
    if (n.data.kind !== "moon" || n.data.idea_id === null) continue;
    const planet = byIdea.get(n.data.idea_id);
    if (!planet) continue;
    const k = counted.get(planet) ?? 0;
    counted.set(planet, k + 1);
    // A fifth of a turn per moon, starting up and to the right; a second lap
    // sits slightly further out rather than on top of the first.
    moons.push({
      node: n,
      planet,
      angle: -Math.PI / 3 + (k % 4) * (Math.PI / 5),
      away: MOON_ORBIT + Math.floor(k / 4) * 16,
    });
  }
  return moons;
}

/** Put every moon where it belongs, given where its planet is right now. */
function settleMoons(moons: Moon[]) {
  for (const m of moons) {
    m.node.x = (m.planet.x ?? 0) + Math.cos(m.angle) * m.away;
    m.node.y = (m.planet.y ?? 0) + Math.sin(m.angle) * m.away;
    // Pinned, so neither the simulation nor a drag pulls one away from the
    // claim it belongs to.
    m.node.fx = m.node.x;
    m.node.fy = m.node.y;
  }
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
  const TRUNK = FOREST_TRUNK;
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
    const mine = ideasOf.get(hub) ?? [];
    const levels = Math.ceil(mine.length / PER_LEVEL);
    placed.trunks.push({
      hub,
      x,
      groundY: GROUND,
      // How far the taproot has to reach: to the deepest idea it feeds.
      deepestY: GROUND + Math.max(1, levels) * ROOT_STEP,
    });

    // Roots: each level fans wider and sits deeper, so the whole thing reads
    // downward from the trunk rather than as a second crown.
    const ideas = ideasOf.get(hub) ?? [];
    ideas.forEach((idea, k) => {
      const level = Math.floor(k / PER_LEVEL) + 1;
      // How many share this level — the last one is usually short.
      const inLevel = Math.min(PER_LEVEL, ideas.length - (level - 1) * PER_LEVEL);
      const slot = k % PER_LEVEL;
      const width = reach(level);
      // Never on the taproot. A single idea at a level used to land exactly
      // on the vertical, so the root it hung from ran straight through it —
      // which reads as a bead on a string rather than a root branching off.
      // Odd counts alternate sides instead of putting one in the middle.
      const spread = inLevel === 1 ? 0.55 : slot / (inLevel - 1) - 0.5;
      const side = inLevel === 1 ? (k % 2 === 0 ? 1 : -1) : 1;
      const across = spread * 2 * width * side;
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

/**
 * A conversation's tree, in screen space.
 *
 * In a forest a conversation is not a dot with a tree painted around it — it
 * *is* the tree, the same stacked-triangle fir the app is named by. So one
 * function owns the shape, and both the drawing and the hit test read it:
 * anything else and what you can click stops matching what you can see, which
 * is the bug that made the old crown-circle feel arbitrary to point at.
 *
 * `apex` is the node's own position; `groundY` is where the trunk stands.
 */
function treeShape(apex: { x: number; y: number }, groundY: number) {
  const height = Math.max(14, groundY - apex.y);
  // Taken from the icon: a little wider than half its height, with the trunk
  // about a sixth of it.
  const halfWidth = height * 0.34;
  const trunkH = height * 0.16;
  const trunkW = Math.max(1.2, halfWidth * 0.14);
  return { height, halfWidth, trunkH, trunkW, apex, groundY };
}

/** Draw the fir. `grow` scales it about its own foot, for the hover glow. */
function drawFir(
  ctx: CanvasRenderingContext2D,
  apex: { x: number; y: number },
  t: ReturnType<typeof treeShape>,
  grow = 1,
) {
  const halfWidth = t.halfWidth * grow;
  const height = t.height * grow;
  const trunkH = t.trunkH * grow;
  const trunkW = t.trunkW * grow;
  const top = t.groundY - height;
  ctx.fillRect(apex.x - trunkW, t.groundY - trunkH, trunkW * 2, trunkH);
  const canopyH = height - trunkH;
  for (let i = 0; i < 3; i++) {
    // Tiers overlap: each starts lower and ends wider than the one above, so
    // the silhouette reads as foliage rather than three stacked triangles.
    const tierTop = top + canopyH * i * 0.3;
    const tierBottom = top + canopyH * (0.5 + i * 0.25);
    const half = halfWidth * (0.5 + i * 0.25);
    ctx.beginPath();
    ctx.moveTo(apex.x, tierTop);
    ctx.lineTo(apex.x + half, tierBottom);
    ctx.lineTo(apex.x - half, tierBottom);
    ctx.closePath();
    ctx.fill();
  }
}

/** Whether a point is inside the tree — canopy or trunk. */
function inTree(t: ReturnType<typeof treeShape>, px: number, py: number): boolean {
  const { apex, groundY, halfWidth, trunkH, trunkW } = t;
  const canopyBottom = groundY - trunkH;
  if (py >= apex.y && py <= canopyBottom) {
    // The canopy is three overlapping triangles, but they share one outline:
    // width grows from nothing at the apex to the full span at the base.
    const down = (py - apex.y) / Math.max(1, canopyBottom - apex.y);
    return Math.abs(px - apex.x) <= halfWidth * down;
  }
  if (py > canopyBottom && py <= groundY) {
    return Math.abs(px - apex.x) <= trunkW * 1.8;
  }
  return false;
}

/** How tall a tree stands above the ground, in world units. */
const FOREST_TRUNK = 160;

/**
 * How far in and out the map goes, and where it stops being a map of things
 * with names and becomes a shape.
 *
 * Past `READABLE_ZOOM` a node draws as a dot in a bed of dots: titles are not
 * drawn at that size, and neither is the hover card — a bubble a fifth of the
 * screen wide, hanging off a speck, describing something you cannot see.
 * Pulled back that far the question is "what shape is this", and the map
 * itself is the answer to it.
 */
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const READABLE_ZOOM = 0.55;
/** One press of a zoom button. About four presses to double. */
const ZOOM_STEP = 1.2;

/** How far a moon sits from the idea it answers, in world units. Close: the
 *  point of it is that it belongs to that one claim. */
const MOON_ORBIT = 46;
/** And how big it is. Smaller than an idea, on purpose. */
const MOON_RADIUS = 3.2;

/** What each spread multiplies the push between nodes by. */
const SPREAD_PUSH: Record<MapSpread, number> = {
  loose: 2.1,
  balanced: 1,
  tight: 0.45,
};

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
  /** Answers and the claims they hang from. Applied every frame rather than
   *  once: a galaxy's planets turn, and a force layout's are still moving. */
  const moonsRef = useRef<Moon[]>([]);
  const [, restyle] = useState(0);
  // Held in a ref rather than state because the draw loop and the hit test
  // read it every frame; the counter is only to get one render out of a
  // change. `buildRef` because rebuilding is what a style change means — the
  // three are different arrangements, not different paint.
  const spreadRef = useRef<MapSpread>("balanced");
  /** Mirrors of the two map settings, so the map's own controls can show
   *  which is on. The refs above are what the draw loop reads. */
  const [style, setStyle] = useState<MapStyle>("nodes");
  const [spread, setSpread] = useState<MapSpread>("balanced");
  const [showArrange, setShowArrange] = useState(false);
  /** A doubt the map asked to answer, so the file it opens starts on that
   *  one rather than at the top. Cleared once the file has taken it. */
  const [answering, setAnswering] = useState<string | null>(null);
  const buildRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const apply = (m: MapStyle, sp: MapSpread) => {
      if (!alive) return;
      // The controls always show what is set, whatever the draw loop is
      // already doing. Skipping this alongside the rebuild left the button
      // saying "Nodes" over a forest, because the refs were current and the
      // state had never been told.
      setStyle(m);
      setSpread(sp);
      if (m === styleRef.current && sp === spreadRef.current) return;
      styleRef.current = m;
      spreadRef.current = sp;
      restyle((n) => n + 1);
      buildRef.current();
    };
    // The first read is not a change, so it sets the ref and rebuilds once —
    // the initial build may already have run under the default.
    void getSettings().then((st) => {
      if (!alive) return;
      apply(st.map_style, st.map_spread ?? "balanced");
    });
    const un = onSettingsChanged((st) => apply(st.map_style, st.map_spread ?? "balanced"));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);

  // Opening a node's file happens over the map, not instead of it — clicking
  // the same node again closes it, clicking a different one swaps the panel's
  // content, rather than navigating away and losing the map's state.
  const [panel, setPanel] = useState<{
    kind: "idea" | "conversation";
    id: number;
    /** For a conversation opened from a citation: which idea's words to flash. */
    flash?: number;
  } | null>(null);
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
  const openConversation = useRef((id: number, flash?: number) => {
    if (onOpenFile) {
      onOpenFile("conversation", id);
      return;
    }
    setPanel((p) =>
      p?.kind === "conversation" && p.id === id && flash === undefined
        ? null
        : { kind: "conversation", id, flash },
    );
  });
  useEffect(() => {
    openConversation.current = (id: number, flash?: number) => {
      if (onOpenFile) {
        onOpenFile("conversation", id);
        return;
      }
      setPanel((p) =>
        p?.kind === "conversation" && p.id === id && flash === undefined
          ? null
          : { kind: "conversation", id, flash },
      );
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

    // Whatever moved the planets this frame, the moons follow.
    settleMoons(moonsRef.current);

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
    const forestGround =
      styleRef.current === "forest" ? toScreen({ x: 0, y: 0 }, w, h).y : null;
    if (styleRef.current === "forest" && placed.trunks.length) {
      const k = viewRef.current.scale * spreadOf(viewRef.current.scale);
      const ground = forestGround ?? 0;
      ctx.strokeStyle = C.related;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, ground);
      ctx.lineTo(w, ground);
      ctx.stroke();
      ctx.globalAlpha = 1;

      for (const trunk of placed.trunks) {
        // The tree itself is drawn with the node, further down — it *is* the
        // node now. What belongs here is only what sits behind everything:
        // the ground it stands on, and the taproot under it.
        const foot = toScreen({ x: trunk.x, y: trunk.groundY }, w, h);
        const deep = toScreen({ x: trunk.x, y: trunk.deepestY }, w, h);
        // A root, not a spike. It wanders slightly off the vertical, tapers
        // as it goes, and frays into two thinner ends — a straight triangle
        // read as a pin holding the tree down.
        const wide = Math.max(1.2, 5 * k);
        const drop = deep.y - foot.y;
        const wander = wide * 1.8;
        ctx.fillStyle = trunk.hub.color;
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(foot.x - wide, foot.y);
        ctx.bezierCurveTo(
          foot.x - wide * 0.7, foot.y + drop * 0.4,
          deep.x - wander - wide, foot.y + drop * 0.75,
          deep.x - wander, deep.y,
        );
        ctx.lineTo(deep.x - wander + wide * 0.35, deep.y - drop * 0.06);
        ctx.bezierCurveTo(
          deep.x - wander * 0.4, foot.y + drop * 0.7,
          foot.x + wide * 0.2, foot.y + drop * 0.45,
          foot.x + wide, foot.y,
        );
        ctx.closePath();
        ctx.fill();
        // The second fork, thinner and shorter, leaving the other way.
        ctx.globalAlpha = 0.34;
        ctx.beginPath();
        ctx.moveTo(foot.x + wide * 0.2, foot.y);
        ctx.bezierCurveTo(
          foot.x + wide * 1.2, foot.y + drop * 0.35,
          deep.x + wander, foot.y + drop * 0.6,
          deep.x + wander * 1.5, foot.y + drop * 0.82,
        );
        ctx.lineTo(deep.x + wander * 1.2, foot.y + drop * 0.84);
        ctx.bezierCurveTo(
          deep.x + wander * 0.5, foot.y + drop * 0.6,
          foot.x + wide * 0.6, foot.y + drop * 0.3,
          foot.x - wide * 0.2, foot.y,
        );
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    const traced = tracedRef.current;
    const isTraced = (n: Node) => traced !== null && n.data.idea_id === traced;
    const inFocus = (n: Node) =>
      !focus ||
      (n.data.kind !== "conversation" && n.data.category === focus) ||
      n === hover ||
      isTraced(n);

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
      // In a forest a root leaves the central taproot at its own depth and
      // goes sideways to the idea. Leaving from the foot instead made every
      // root a separate spoke fanning out of one point, which reads as a
      // splayed hand rather than a root system — a real one runs down and
      // branches off as it goes.
      const sa =
        styleRef.current === "forest" && link.kind === "from"
          ? toScreen({ x: a.x, y: (b.y ?? 0) }, w, h)
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
              : link.kind === "answers"
                ? // The colour of the claim being answered, so the tether
                  // reads as part of that node rather than as another
                  // relation between two ideas.
                  (link.source as Node).color
                : C.category;
        ctx.lineWidth = link.kind === "category" ? 1 : link.kind === "answers" ? 1 : 1.6;
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
      // A tree's node position is its apex — the tip of the top triangle. Every
      // ring below would otherwise be drawn around a point in the sky above
      // the thing it is meant to be marking.
      const tree =
        styleRef.current === "forest" && n.data.kind === "conversation" && forestGround !== null
          ? treeShape(s, forestGround)
          : null;
      const midY = tree ? s.y + tree.height * 0.5 : s.y;
      const ringR = tree ? Math.max(tree.halfWidth, tree.height * 0.45) : r;
      ctx.globalAlpha = inFocus(n) ? 1 : 0.22;

      // The same ring the pointer draws, so running down the list of what was
      // taken from a conversation picks each one out on the map in turn.
      if (hover === n || isTraced(n)) {
        // A disc behind a tree reads as a node appearing under it — the one
        // shape the forest is meant not to have. Pointed at, a tree glows as
        // a tree: the same silhouette, larger and softer, behind itself.
        if (tree) {
          ctx.fillStyle = C.hoverRing;
          drawFir(ctx, s, tree, 1.22);
        } else {
          ctx.beginPath();
          ctx.arc(s.x, midY, ringR + 6, 0, Math.PI * 2);
          ctx.fillStyle = C.hoverRing;
          ctx.fill();
        }
      }
      if (n.data.shared) {
        ctx.beginPath();
        ctx.arc(s.x, midY, ringR + 7, 0, Math.PI * 2);
        ctx.fillStyle = C.halo;
        ctx.fill();
      }

      // A claim that was rewritten while you were away gets a slow ring, so the
      // change is noticed rather than found later by accident.
      if (n.data.just_revised) {
        const t = ((performance.now() - startedRef.current) / 1600) % 1;
        ctx.beginPath();
        ctx.arc(s.x, midY, ringR + 6 + t * 16, 0, Math.PI * 2);
        ctx.strokeStyle = C.labelConversation;
        ctx.globalAlpha = (1 - t) * (inFocus(n) ? 0.55 : 0.15);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = inFocus(n) ? 1 : 0.22;
      }

      if (tree) {
        ctx.fillStyle = n.color;
        drawFir(ctx, s, tree);
      } else {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();
      }
    }

    // Labels last so nothing is drawn over them. Every node gets one — the
    // force simulation's collision radius accounts for label size precisely
    // so that spacing, not skipping, is what keeps them apart.
    ctx.textAlign = "left";
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
    // Pulled back far enough the map stops being a set of things with names
    // and becomes a shape. Titles there are unreadable at that size and
    // land on each other whatever the crowding test decides, so they are not
    // drawn at all — the landmarks and whatever is being pointed at still are.
    const tooFarOutToRead = viewRef.current.scale < READABLE_ZOOM;

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

      // Conversation titles get a wider column and an extra line — and the
      // one node being pointed at gets far more of both.
      //
      // Every label on the map is squeezed into a narrow column so a hundred
      // of them can coexist. The hovered one has no such problem: it is the
      // only thing being read, it has a card behind it, and everything else is
      // dimmed. In the narrow column a claim of any length wrapped into four
      // short lines and then lost its ending to an ellipsis — a bubble taller
      // than it was wide, cutting off the very words it appeared to show. Wide
      // enough to read a sentence across, and enough lines to finish it.
      const isHovered = hover === n;
      const maxLabelWidth = isHovered
        ? Math.min(w * 0.42, baseLabelWidth * 3.2)
        : isConversation
          ? baseLabelWidth * 1.4
          : baseLabelWidth;
      const lineHeight = labelPx * 1.3;
      const lines = wrapLines(
        ctx,
        n.data.label,
        maxLabelWidth,
        isHovered ? 8 : isConversation ? 5 : 4,
      );
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      // Beside the node, not beneath it. Underneath, a label sat on whatever
      // was below — links, roots, the next node down — and on a dense map the
      // thing being read was the thing most likely to be covered. To the
      // right it has the node's own clear space to occupy, and a column of
      // labels reads down the map rather than colliding across it.
      const gap = Math.max(4, labelPx * 0.45);
      // Beside whatever is actually drawn: a circle's edge, or a tree's
      // widest point at the height of its middle. Anchored to the node's own
      // position a tree's name floated beside its tip, level with nothing.
      const tree =
        styleRef.current === "forest" && isConversation && forestGround !== null
          ? treeShape(s, forestGround)
          : null;
      const half = tree ? tree.halfWidth : r;
      // The hovered card is several times wider than an ordinary label, so
      // near the right edge it ran off the canvas and took the end of the
      // claim with it. Only the card flips: an ordinary label is narrow
      // enough that the column reads better staying on one side.
      const pad = Math.max(7, labelPx * 0.85);
      const flip = isHovered && s.x + half + gap + widest + pad > w;
      const textX = flip ? s.x - half - gap - widest : s.x + half + gap;
      const anchorY = tree ? s.y + tree.height * 0.5 : s.y;
      // A card that would hang off the top or the bottom is pushed back
      // inside. Eight lines of claim is tall enough for this to matter, and a
      // bubble cut off by the edge of the map is the same failure as one cut
      // off by its own width.
      const blockH = lines.length * lineHeight;
      const textY = isHovered
        ? Math.min(
            Math.max(anchorY - blockH / 2, pad + 4),
            Math.max(pad + 4, h - blockH - pad - 4),
          )
        : anchorY - blockH / 2;
      const box = {
        x0: textX - 3,
        x1: textX + widest + 3,
        y0: textY - 3,
        y1: textY + lines.length * lineHeight + 3,
      };
      // Only what is on screen counts, for drawing and for the crowding test
      // below. A title two screens away is not in anyone's way, and letting it
      // vote meant zooming in never uncrowded the map.
      if (box.x1 < 0 || box.x0 > w || box.y1 < 0 || box.y0 > h) continue;
      laid.push({ n, lines, x: textX, y: textY, lineHeight, isConversation, box });
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
      if (!mustDraw && tooFarOutToRead) continue;
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
        // Generous relative to the text, not a hairline around it: the card
        // exists to lift the words off a busy map, and a tight one reads as a
        // box drawn on the label rather than as something behind it.
        const pad = Math.max(7, labelPx * 0.85);
        const widest = Math.max(...l.lines.map((line) => ctx.measureText(line).width));
        // The text is drawn from `l.y` downward — `textBaseline` is "top" —
        // so the card is that block plus even padding. It used to start most
        // of a line higher and stop short of the last line, which put the
        // card above the words it was meant to be behind.
        const boxH = l.lines.length * l.lineHeight + pad * 2;
        const boxW = widest + pad * 2;
        const bx = l.x - pad;
        const by = l.y - pad;
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
    // A tree is far wider and taller than the node it is drawn from, and the
    // fit was framing the node. With the arrangement spread out, the outermost
    // trees and their names ran off the edge of a view that believed it had
    // included everything.
    const forest = styleRef.current === "forest";
    const treeHalf = forest ? FOREST_TRUNK * 0.34 : 0;
    const maxR = Math.max(...nodes.map((n) => n.r));
    let pad = Math.max(maxR, treeHalf) + 12;
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
      const isMoon = d.kind === "moon";
      return {
        data: d,
        // A moon is visibly smaller than the claim it hangs from. It is the
        // reply, not a second idea — drawn the same size it would read as one
        // more thing to be argued with rather than as the argument back.
        r: isConversation
          ? CONVERSATION_RADIUS + Math.min(12, d.weight * 2)
          : isMoon
            ? MOON_RADIUS
            : IDEA_RADIUS + Math.min(8, (d.weight - 1) * 4),
        // Its planet's colour: an answer is about the same subject as the
        // claim it defends, and giving it one of its own would put a stray
        // colour in the key for something that is not a subject.
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
      moonsRef.current = moonsOf(nodes);
      settleMoons(moonsRef.current);
      simRef.current = null;
      fitToView();
      return;
    }
    placedRef.current = NOTHING_PLACED;
    for (const n of nodes) {
      n.fx = null;
      n.fy = null;
    }
    moonsRef.current = moonsOf(nodes);

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
            // A moon is already pinned beside its planet every frame, so this
            // spring can only pull on the *planet*. At the "related" distance
            // it would shove the claim 280 units away from its own answer.
            if (l.kind === "answers") return MOON_ORBIT;
            if (l.kind !== "from") return rules.related;
            const n = orbitCount.get((l.source as Node).data.id) ?? 1;
            return rules.orbit + Math.max(0, n - 4) * rules.orbitGrowth;
          })
          .strength((l) => (l.kind === "from" ? 0.7 : l.kind === "answers" ? 0 : 0.15)),
      )
      // Bigger nodes push harder, so conversations claim their own space.
      .force(
        "charge",
        forceManyBody<Node>().strength((n) => {
          // A moon takes no part in the push: it is held where it is put, and
          // all its charge could do is shove the very claim it belongs to.
          if (n.data.kind === "moon") return 0;
          const rules = ruleset(planWidth());
          // How hard everything pushes apart, which is the one thing that
          // decides whether the map reads as a shape or as a list of things.
          return (rules.charge - n.r * rules.chargeByRadius) * SPREAD_PUSH[spreadRef.current];
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
          // A moon holds station on its planet and is unnamed unless pointed
          // at, so reserving a claim's worth of label space around one would
          // push the map apart to make room for nothing.
          if (n.data.kind === "moon") return n.r + 2;
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
    // Before the frame is measured, or a moon the simulation flung somewhere
    // is part of what the map is framed around.
    settleMoons(moonsRef.current);
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

  /**
   * Zoom about the middle of the map, by a factor.
   *
   * The same arithmetic the wheel does, minus the cursor: a button has no
   * position on the map, so the centre of the frame is what stays put. The
   * spread rides along, exactly as it does on the wheel — without that, the
   * map slides sideways every time the zoom changes.
   */
  function zoomBy(factor: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelTravel();
    const v = viewRef.current;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.scale * factor));
    if (scale === v.scale) return;
    const k = (scale * spreadOf(scale)) / (v.scale * spreadOf(v.scale));
    v.x *= k;
    v.y *= k;
    v.scale = scale;
    // Pulling back is a way of saying you are done with what you were looking
    // at, the same as it is on the wheel.
    if (factor < 1 && focusNodeRef.current && !panelRef.current) {
      focusNodeRef.current = null;
      revealRef.current = new Set();
    }
    dropHover();
  }

  /** Let go of whatever was being pointed at. The overlay is anchored to
   *  where the node was on screen, so any move of the view leaves it sitting
   *  over empty map. */
  function dropHover() {
    hoverRef.current = null;
    keepAliveRef.current = null;
    setHovered(null);
    setHoverAt(null);
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

    const forestGround =
      styleRef.current === "forest" ? toScreen({ x: 0, y: 0 }, w, h).y : null;

    let best: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);

      // A conversation in a forest is a tree, so the tree is what answers to
      // the pointer. Testing a circle at the apex meant the whole canopy —
      // the part that actually looks like the thing — was dead, and the only
      // live spot was a patch of sky above it.
      if (forestGround !== null && n.data.kind === "conversation") {
        if (inTree(treeShape(s, forestGround), px, py)) {
          // Nearest by apex, so two overlapping trees still resolve.
          const d = Math.hypot(px - s.x, py - s.y);
          if (d < bestDist) {
            best = n;
            bestDist = d;
          }
        }
        continue;
      }
      const drawn = drawnRadius(n.r, viewRef.current.scale, canvas.clientWidth, styleRef.current);
      // The comfort radius is in screen pixels and did not shrink with the
      // map. Zoomed out, a node draws as a dot and still answered to the
      // pointer from a couple of centimetres away — so nodes lit up with the
      // pointer visibly nowhere near them. It can still be generous, but
      // never much larger than the thing it is standing in for.
      const comfort = ruleset(canvas.clientWidth, styleRef.current).hitRadius;
      const r = Math.max(drawn + 4, Math.min(comfort, drawn * 2));
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
          // Pulled back past the point where anything is legible, pointing
          // stops meaning anything. Nodes draw as dots a few pixels apart, so
          // the pointer is over one of *something* wherever it rests, and the
          // map spent the whole time dimmed behind a card naming a speck the
          // cursor happened to land on. Clicking and dragging still find their
          // node: those are decisions, not a side effect of where the mouse
          // came to rest.
          let hit =
            viewRef.current.scale < READABLE_ZOOM ? null : nodeAt(e.clientX, e.clientY);

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
          // Same reasoning as the node cards above: at that size the lines
          // are a pixel apart and the popup is a fifth of the screen, so it
          // is a large explanation of a line nobody can point at on purpose.
          const edge =
            viewRef.current.scale < READABLE_ZOOM ? null : edgeAt(e.clientX, e.clientY);
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
          // A moon opens the file of the idea it hangs from — that is where
          // its dispute lives, and where the answer can be added to or taken
          // back. It has no file of its own to open, deliberately: it is a
          // reply to a claim, not a claim.
          const isConversation = hit.data.kind === "conversation";
          const id = isConversation ? hit.data.session_id : hit.data.idea_id;
          if (id === null) return;
          const kind = isConversation ? "conversation" : "idea";
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
          const scale = Math.min(
            MAX_ZOOM,
            Math.max(MIN_ZOOM, v.scale * Math.exp(-e.deltaY * 0.0015)),
          );
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
          // The overlay is anchored to where the node was on screen when it
          // was pointed at. Zooming moves the node and left the highlight
          // behind, sitting over empty map — so it goes, the same way it does
          // when the map is dragged.
          dropHover();
        }}
      />

      {/* The map's own zoom, as icons, in the corner opposite the arrangement
          panel. "Fit" used to be a bare text button pinned to the top left —
          which is exactly where the arrangement chip sits, so the one control
          that gets you back to seeing everything was underneath the one that
          changes how it is drawn, invisible and unclickable. It was also the
          only button in the app wearing none of the app's own clothes. */}
      {!empty && (
        <div className="graph-zoom">
          <button
            type="button"
            className="icon-btn"
            data-tip="Closer"
            aria-label="Zoom in"
            onClick={() => zoomBy(ZOOM_STEP)}
          >
            <IconZoomIn />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-tip="Further back"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
          >
            <IconZoomOut />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-tip="Frame everything"
            aria-label="Frame everything"
            onClick={() => {
              cancelTravel();
              focusNodeRef.current = null;
              revealRef.current = new Set();
              dropHover();
              fitToView();
              simRef.current?.alpha(0.4).restart();
            }}
          >
            <IconFit />
          </button>
        </div>
      )}

      {!empty && (
        <div className="graph-arrange">
          {/* The arrangement lives here rather than only in Settings. It is
              not a preference you set once — it is a way of looking at what
              is on screen, and the whole point of trying another one is
              seeing this map in it. Leaving the switch two tabs away made it
              a thing you configure instead of a thing you use. */}
          <button
            type="button"
            className={showArrange ? "graph-arrange-btn on" : "graph-arrange-btn"}
            aria-expanded={showArrange}
            onClick={() => setShowArrange((v) => !v)}
          >
            {MAP_STYLES.find((m) => m.value === style)?.label ?? "Arrange"}
          </button>
          {showArrange && (
            <div className="graph-arrange-panel">
              <p className="graph-arrange-head">Arrangement</p>
              <div className="graph-arrange-row">
                {MAP_STYLES.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    className={style === m.value ? "on" : undefined}
                    title={m.blurb}
                    onClick={() => {
                      void getSettings().then((st) =>
                        saveSettings({ ...st, map_style: m.value }),
                      );
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="graph-arrange-head">How much room they take</p>
              <div className="graph-arrange-row">
                {MAP_SPREADS.map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    className={spread === m.value ? "on" : undefined}
                    title={m.blurb}
                    onClick={() => {
                      void getSettings().then((st) =>
                        saveSettings({ ...st, map_spread: m.value }),
                      );
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {empty && (
        <p className="empty graph-empty">
          Nothing mapped yet. Have a conversation and press Done.
        </p>
      )}

      {hovered && hoverAt && (
        <Nudges
          node={hovered}
          at={hoverAt}
          onAnswer={
            hovered.kind === "idea" && hovered.idea_id !== null
              ? (challenge) => {
                  const id = hovered.idea_id!;
                  cancelTravel();
                  dropHover();
                  // The file opens on that exact doubt, with the box already
                  // waiting. Opening it at the top and leaving them to find
                  // the note again is how the click stops being worth making.
                  setAnswering(challenge);
                  if (onOpenFile) onOpenFile("idea", id);
                  else setPanel({ kind: "idea", id });
                }
              : undefined
          }
        />
      )}

      {hovered && (
        <div
          className={`graph-tip ${hoverAt && hoverAt.below ? "top" : "bottom"} ${
            hoverAt && hoverAt.x > (canvasRef.current?.clientWidth ?? 0) / 2 ? "left" : "right"
          }`}
        >
          <span className="muted">
            {hovered.kind === "conversation"
              ? `Conversation · ${hovered.weight} idea${hovered.weight === 1 ? "" : "s"}`
              : hovered.kind === "moon"
                ? `Your answer${hovered.category ? ` · ${hovered.category}` : ""}`
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
              openChallenge={answering}
              onOpenConversation={(id, ideaId) => openConversation.current(id, ideaId)}
              onClose={() => {
                setAnswering(null);
                setPanel(null);
              }}
            />
          ) : (
            <ConversationFile
              sessionId={panel.id}
              highlightIdea={panel.flash}
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
  onAnswer,
}: {
  node: GraphNode;
  at: { x: number; y: number; r: number; color: string; below: boolean };
  /** Answer one of the doubts, from here. Absent where there is no idea for
   *  the answer to belong to — a conversation's notes are about the whole
   *  session, and have no single claim to hang a moon from. */
  onAnswer?: (challenge: string) => void;
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
        // A doubt can be answered from here, without first opening the file
        // and finding it again. The map is where you are when you notice the
        // red mark, and making you go somewhere else to reply to it is how a
        // reply stops being worth making.
        const answerable = p.kind === "weak" && onAnswer !== undefined;
        const style = {
          left: at.x,
          top: at.y,
          "--dx": `${Math.cos(angle) * radius}px`,
          "--dy": `${Math.sin(angle) * radius}px`,
          animationDelay: `${i * 45}ms`,
        } as React.CSSProperties;
        const body = (
          <span className="ai-text">
            {p.text}
            {answerable && <span className="ai-answer">Answer this dispute →</span>}
          </span>
        );
        return answerable ? (
          <button
            type="button"
            key={i}
            className={`ai-nudge ${p.kind} answerable${at.below ? " up" : ""}`}
            style={style}
            onClick={() => onAnswer(p.text)}
          >
            AI
            {body}
          </button>
        ) : (
          <span key={i} className={`ai-nudge ${p.kind}${at.below ? " up" : ""}`} style={style}>
            AI
            {body}
          </span>
        );
      })}
    </div>
  );
}
