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

const CONVERSATION_RADIUS = 18;
const IDEA_RADIUS = 8.5;

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

/** A stable numeric seed from a node id string, for per-node variation. */
function hashText(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return Math.abs(h);
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
  /** Sunflower theme: the stem and leaves of a plant. */
  stem: string;
  /** The head of a sunflower, and the pollen that drifts between them. */
  petal: string;
  pollen: string;
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
    stem: verdant,
    petal: gold,
    pollen: gold,
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

/** The canvas font for a label of this size. */
function labelFont(px: number, bold: boolean): string {
  return `${bold ? "600 " : ""}${px}px ui-sans-serif, system-ui, sans-serif`;
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
/**
 * A node's drawn radius, in screen pixels.
 *
 * Exactly proportional to the zoom, like everything else on the map. Sizes
 * used to stop growing at a zoom of two while the distances between nodes
 * kept growing, and positions got a "breathing" factor that sizes did not —
 * a map whose things and gaps zoom at different rates cannot show spacing,
 * so every spacing setting looked the same once framed.
 */
function drawnRadius(base: number, scale: number, width: number, style: MapStyle): number {
  return base * scale * ruleset(width, style).nodeScale;
}

/** What each arrangement multiplies a node's drawn radius by. */
const STYLE_SCALE: Record<MapStyle, number> = {
  nodes: 0.85,
  forest: 0.9,
  sunflower: 0.9,
  galaxy: 0.82,
  simplified: 0.85,
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

interface Pt {
  x: number;
  y: number;
}

/** A tapered quadratic in world units: a root, a limb. */
interface Taper {
  from: Pt;
  c: Pt;
  to: Pt;
  /** Half-widths at the two ends. */
  w0: number;
  w1: number;
}

/** The last run of a forest root, ending at the idea it is. */
interface ForestRoot extends Taper {
  hub: Node;
  idea: Node;
  seed: number;
}

/** Shared wood from a trunk's foot to where its roots divide. */
interface ForestLimb extends Taper {
  hub: Node;
  ideas: Node[];
}

/** One idea as a petal of its sunflower. */
interface Petal {
  hub: Node;
  angle: number;
  /** Where the petal starts, out from the head's centre — under the disc. */
  inner: number;
  len: number;
  halfW: number;
  /** 0 in front; later rings sit behind it. */
  ring: number;
}

/** A sunflower's head. */
interface Flower {
  disc: number;
  /** Plain petals in the slots no idea takes, so a head with few ideas is
   *  still a whole flower. */
  filler: { angle: number; len: number; halfW: number }[];
  /** How far the flower reaches from its stalk, petals included. */
  reach: number;
}

type Extent = { x0: number; y0: number; x1: number; y1: number };

/**
 * Everything an arranged style needs beyond the node positions themselves.
 *
 * All of it in world units, worked out once when the map is built. The draw
 * loop paints it under one transform and the hit test reads the same shapes,
 * so what you see, what you can point at and what the spacing setting moves
 * are one geometry — not three reconstructions of it in screen pixels.
 */
interface Placed {
  /** Rings to draw, as hub and radius. Galaxy only. */
  rings: { hub: Node; radius: number }[];
  orbits: Orbiting[];
  roots: ForestRoot[];
  limbs: ForestLimb[];
  /** Relation lines routed under the forest floor. */
  lanes: Map<Link, Pt[]>;
  /** Each conversation's tree. Forest only. */
  trees: Map<Node, TreeSpec>;
  petals: Map<Node, Petal>;
  flowers: Map<Node, Flower>;
  /** Which way is away from an idea's own cluster, for its moons. */
  outward: Map<Node, number>;
  /** What is drawn, not just where nodes sit — trees, roots and stalks
   *  reach well past their nodes, and framing has to include them. */
  extent: Extent | null;
}

function emptyPlaced(): Placed {
  return {
    rings: [],
    orbits: [],
    roots: [],
    limbs: [],
    lanes: new Map(),
    trees: new Map(),
    petals: new Map(),
    flowers: new Map(),
    outward: new Map(),
    extent: null,
  };
}

const NOTHING_PLACED: Placed = emptyPlaced();

/** Widen an extent to take in a box. */
function grow(e: Extent | null, x0: number, y0: number, x1: number, y1: number): Extent {
  if (!e) return { x0, y0, x1, y1 };
  return {
    x0: Math.min(e.x0, x0),
    y0: Math.min(e.y0, y0),
    x1: Math.max(e.x1, x1),
    y1: Math.max(e.y1, y1),
  };
}

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
function moonsOf(nodes: Node[], outward?: Map<Node, number>): Moon[] {
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
    // Where the arrangement knows which way is out — past a root's tip, a
    // petal's end — the moons fan around that, clear of the cluster. Else a
    // fifth of a turn per moon, starting up and to the right. A second lap
    // sits slightly further out rather than on top of the first.
    const out = outward?.get(planet);
    moons.push({
      node: n,
      planet,
      angle:
        out !== undefined
          ? out + ((k % 4) - 1.5) * 0.4
          : -Math.PI / 3 + (k % 4) * (Math.PI / 5),
      away: MOON_ORBIT + Math.floor(k / 4) * 16,
    });
  }
  return moons;
}

/** Put every moon where it belongs, given where its planet is right now. */
function settleMoons(moons: Moon[], except?: Node | null) {
  for (const m of moons) {
    // The moon being pointed at stands still: its overlay is anchored where
    // it was, and a moon that kept moving read as the map drifting away from
    // its own highlight.
    if (except && m.node === except) continue;
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

/** How far out a system's `r`th ring sits. */
function ringRadius(r: number, inner: number): number {
  return (96 + r * 62) * inner;
}

/** Ideas in orbit around the conversation they came from. */
function arrangeGalaxy(
  nodes: Node[],
  links: Link[],
  spread: MapSpread = "balanced",
  flat = 1,
): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed = emptyPlaced();
  const inner = SPREAD_INNER[spread];

  // Each system's size first. The spiral used to step a fixed distance, so a
  // system with many rings reached through its neighbours' — and the spacing
  // setting scaled the rings along with the gaps, which framing then undid.
  // The rings keep their size now; the setting moves the systems.
  const ringsByHub = new Map<Node, Node[][]>();
  const size = new Map<Node, number>();
  for (const hub of hubs) {
    const rings = ringsOf(ideasOf.get(hub) ?? [], links);
    ringsByHub.set(hub, rings);
    size.set(hub, (rings.length ? ringRadius(rings.length - 1, inner) : 0) + hub.r + 24);
  }
  const gap = 90 * SPREAD_GAP[spread];
  const widest = Math.max(1, ...size.values());

  // A golden-angle spiral: galaxies do not sit on a grid, and this spaces
  // them without any two landing at the same distance and angle. The first
  // sits at the centre, so a folder with one or two conversations is not
  // framed around an empty middle.
  const pos = hubs.map((_, i) => {
    const away = i === 0 ? 0 : (widest * 2 + gap) * Math.sqrt(i) * 0.62;
    return { x: Math.cos(i * 2.399963) * away, y: Math.sin(i * 2.399963) * away * flat };
  });
  // The spiral is flattened to the pane and the rings are not, so two
  // systems can still overlap. Push apart whatever is closer than its two
  // sizes and the gap; the flattening survives wherever it fits.
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < hubs.length; i++) {
      for (let j = i + 1; j < hubs.length; j++) {
        const need = size.get(hubs[i])! + size.get(hubs[j])! + gap;
        let dx = pos[j].x - pos[i].x;
        let dy = pos[j].y - pos[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= need) continue;
        if (d < 1e-3) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const push = (need - d) / 2 / d;
        pos[i].x -= dx * push;
        pos[i].y -= dy * push;
        pos[j].x += dx * push;
        pos[j].y += dy * push;
        moved = true;
      }
    }
    if (!moved) break;
  }

  let outer = 0;
  hubs.forEach((hub, i) => {
    hub.x = pos[i].x;
    hub.y = pos[i].y;
    hub.fx = hub.x;
    hub.fy = hub.y;
    const s = size.get(hub)!;
    outer = Math.max(outer, Math.hypot(hub.x, hub.y) + s);
    placed.extent = grow(placed.extent, hub.x - s, hub.y - s, hub.x + s, hub.y + s);
    (ringsByHub.get(hub) ?? []).forEach((ring, r) => {
      const radius = ringRadius(r, inner);
      placed.rings.push({ hub, radius });
      ring.forEach((idea, k) => {
        // Offset per ring so neighbouring orbits do not line their nodes up
        // into spokes.
        const angle = (k / ring.length) * Math.PI * 2 + r * 1.1;
        placed.orbits.push({ node: idea, hub, radius, angle });
        idea.x = (hub.x ?? 0) + Math.cos(angle) * radius;
        idea.y = (hub.y ?? 0) + Math.sin(angle) * radius;
      });
    });
  });

  // Ideas whose conversation is gone drift around the outside of it all.
  loose.forEach((n, i) => {
    const away = outer + 50 + i * 26 * inner;
    n.x = Math.cos(i * 2.399963) * away;
    n.y = Math.sin(i * 2.399963) * away * flat;
    n.fx = n.x;
    n.fy = n.y;
    placed.extent = grow(placed.extent, n.x - 12, n.y - 12, n.x + 12, n.y + 12);
  });
  return placed;
}

/**
 * Each conversation with its ideas on a circle around it — the plainest
 * picture. The circles are sized to their ideas and set out in rows, about as
 * wide as the window is shaped; the spacing setting is the gap between them.
 */
function arrangeSimplified(
  nodes: Node[],
  links: Link[],
  spread: MapSpread = "balanced",
  aspect = 1.5,
): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed = emptyPlaced();
  const inner = SPREAD_INNER[spread];
  const gap = 70 * SPREAD_GAP[spread];
  const circles = hubs.map((hub) => {
    const ideas = ideasOf.get(hub) ?? [];
    // Round enough that neighbouring ideas on it sit a readable step apart.
    const radius = Math.max(70 * inner, (ideas.length * 40 * inner) / (Math.PI * 2));
    return { hub, ideas, radius, half: radius + 24 };
  });

  const area = circles.reduce((s, c) => s + (c.half * 2 + gap) ** 2, 0);
  const rowWidth = Math.max(0, ...circles.map((c) => c.half * 2), Math.sqrt(area * aspect));
  const rows: (typeof circles)[] = [];
  let row: typeof circles = [];
  let used = 0;
  for (const c of circles) {
    const need = (row.length ? gap : 0) + c.half * 2;
    if (row.length && used + need > rowWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += (row.length ? gap : 0) + c.half * 2;
    row.push(c);
  }
  if (row.length) rows.push(row);

  const heights = rows.map((r) => Math.max(...r.map((c) => c.half * 2)));
  const totalH = heights.reduce((s, h) => s + h, 0) + gap * Math.max(0, rows.length - 1);
  let y = -totalH / 2;
  rows.forEach((r, i) => {
    const width = r.reduce((s, c) => s + c.half * 2, 0) + gap * (r.length - 1);
    let x = -width / 2;
    const cy = y + heights[i] / 2;
    for (const c of r) {
      const cx = x + c.half;
      x += c.half * 2 + gap;
      c.hub.x = cx;
      c.hub.y = cy;
      c.hub.fx = cx;
      c.hub.fy = cy;
      if (c.ideas.length) placed.rings.push({ hub: c.hub, radius: c.radius });
      c.ideas.forEach((idea, k) => {
        const angle = -Math.PI / 2 + (k / c.ideas.length) * Math.PI * 2;
        idea.x = cx + Math.cos(angle) * c.radius;
        idea.y = cy + Math.sin(angle) * c.radius;
        idea.fx = idea.x;
        idea.fy = idea.y;
        placed.outward.set(idea, angle);
      });
      placed.extent = grow(placed.extent, cx - c.half, cy - c.half, cx + c.half, cy + c.half);
    }
    y += heights[i] + gap;
  });

  // Ideas whose conversation is gone, in a row underneath.
  loose.forEach((n, i) => {
    n.x = (i - (loose.length - 1) / 2) * 60 * inner;
    n.y = totalH / 2 + gap;
    n.fx = n.x;
    n.fy = n.y;
    placed.extent = grow(placed.extent, n.x - 12, n.y - 12, n.x + 12, n.y + 12);
  });
  return placed;
}

/**
 * A tree per conversation, its ideas the roots beneath it.
 *
 * Every tree's root system is sized from its own ideas, and the trees stand
 * that far apart plus a gap. The gap is what the spacing setting changes; the
 * trees and their roots keep their size either side of it, so the setting
 * reads as distance rather than as a zoom.
 */
function arrangeForest(
  nodes: Node[],
  links: Link[],
  spread: MapSpread = "balanced",
  mixed = false,
): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed = emptyPlaced();
  const inner = SPREAD_INNER[spread];
  const gap = 70 * SPREAD_GAP[spread];

  const systems = hubs.map((hub) => {
    const ideas = ideasOf.get(hub) ?? [];
    const n = ideas.length;
    // With the secret forest on, each conversation grows its own species,
    // seeded by its id so a tree stays the same tree across rebuilds. How
    // tall it has grown is how much came out of it.
    const kind = mixed ? TREE_KINDS[hashText(hub.data.id) % TREE_KINDS.length] : "fir";
    const tree = buildTree(kind, n);
    // How much of the lower half-ellipse the tips fan across: a pair hangs
    // nearly straight down, a crowd opens out toward the grass either side.
    const span = n <= 1 ? 0 : Math.min(Math.PI - 0.64, (n - 1) * 0.5);
    // Wide enough that neighbouring tips sit a readable distance apart along
    // the front, and never so shallow the roots skim the surface.
    const tipGap = 48 * inner;
    const a = Math.max(80 * inner, span > 0 ? ((n - 1) * tipGap) / (0.8 * span) : 0);
    const b = Math.max(76 * inner, a * 0.6);
    const reach = n === 0 ? 0 : n === 1 ? 20 : a * Math.sin(span / 2) + 22;
    return { hub, ideas, tree, span, a, b, half: Math.max(reach, tree.halfWidth + 12) };
  });

  const total =
    systems.reduce((s, sy) => s + sy.half * 2, 0) + gap * Math.max(0, systems.length - 1);
  let cursor = -total / 2;
  let deepest = 0;
  for (const sy of systems) {
    const x = cursor + sy.half;
    cursor += sy.half * 2 + gap;
    sy.hub.x = x;
    sy.hub.y = -sy.tree.height;
    sy.hub.fx = sy.hub.x;
    sy.hub.fy = sy.hub.y;
    placed.trees.set(sy.hub, sy.tree);
    layRoots(placed, sy.hub, sy.ideas, x, sy.span, sy.a, sy.b, sy.tree.trunkHalf);
    const depth = sy.ideas.length ? sy.b : 0;
    deepest = Math.max(deepest, depth);
    placed.extent = grow(placed.extent, x - sy.half, -sy.tree.height - 8, x + sy.half, depth + 12);
  }

  // Ideas whose conversation is gone: a row under every root system, where
  // nothing of any tree stands over them.
  const looseY = deepest + 44;
  loose.forEach((n, i) => {
    n.x = (i - (loose.length - 1) / 2) * 90 * inner;
    n.y = looseY;
    n.fx = n.x;
    n.fy = n.y;
    placed.extent = grow(placed.extent, n.x - 12, looseY - 12, n.x + 12, looseY + 12);
  });
  routeLanes(placed, links, (loose.length ? looseY : deepest) + 40);
  return placed;
}

/**
 * One tree's roots, as a root system rather than a bundle of wires: a few
 * limbs leave the trunk's foot, and each divides into the roots that end at
 * its ideas.
 *
 * Nothing crosses, by construction. The tips lie along the lower half of an
 * ellipse in angular order, each limb takes a contiguous run of them, and the
 * limbs leave the foot in that same order — so every root stays inside its
 * own sector. And because the tips are on a convex front, the ground straight
 * below any tip is clear of its own tree, which is what lets a relation line
 * drop from a tip without crossing a root on its way under the forest.
 */
function layRoots(
  placed: Placed,
  hub: Node,
  ideas: Node[],
  x: number,
  span: number,
  a: number,
  b: number,
  trunkW: number,
) {
  const n = ideas.length;
  if (!n) return;
  const angles = ideas.map((_, i) =>
    n === 1 ? Math.PI / 2 : Math.PI / 2 - span / 2 + (span * i) / (n - 1),
  );
  const tips = ideas.map((idea, i) => {
    idea.x = x + Math.cos(angles[i]) * a;
    idea.y = Math.sin(angles[i]) * b;
    idea.fx = idea.x;
    idea.fy = idea.y;
    placed.outward.set(idea, angles[i]);
    return { x: idea.x, y: idea.y };
  });
  // The root ends blunt, at the idea's own width: the tip is the marker.
  const tipW = (idea: Node) => 1.2 + idea.r * 0.09;
  const seedOf = (idea: Node) => idea.data.idea_id ?? hashText(idea.data.id);

  const groups = n <= 2 ? n : Math.min(5, Math.max(2, Math.round(n / 3)));
  let start = 0;
  for (let g = 0; g < groups; g++) {
    const size = Math.floor(n / groups) + (g < n % groups ? 1 : 0);
    const members = ideas.slice(start, start + size);
    const at = tips.slice(start, start + size);
    const mean = angles.slice(start, start + size).reduce((s, t) => s + t, 0) / size;
    start += size;
    // The first group holds the rightmost tips, so its limb leaves the right
    // of the trunk: feet in the same order as the sectors they feed.
    const foot = { x: x + trunkW * 0.8 * (1 - (2 * (g + 0.5)) / groups), y: 0 };
    if (size === 1) {
      const idea = members[0];
      placed.roots.push({
        hub,
        idea,
        seed: seedOf(idea),
        from: foot,
        c: dive(foot, at[0]),
        to: at[0],
        w0: Math.min(3.4, trunkW * 1.5 + 1),
        w1: tipW(idea),
      });
      continue;
    }
    const fork = { x: x + Math.cos(mean) * a * 0.5, y: Math.sin(mean) * b * 0.5 };
    const limb: ForestLimb = {
      hub,
      ideas: members,
      from: foot,
      c: dive(foot, fork),
      to: fork,
      w0: Math.min(3 + size * 0.45, trunkW * 1.6 + 1),
      w1: Math.min(2 + size * 0.2, trunkW * 1.2 + 0.8),
    };
    placed.limbs.push(limb);
    members.forEach((idea, j) => {
      const tip = at[j];
      const len = Math.hypot(tip.x - fork.x, tip.y - fork.y);
      placed.roots.push({
        hub,
        idea,
        seed: seedOf(idea),
        from: fork,
        // A little sag, the way a root follows the soil down.
        c: { x: (fork.x + tip.x) / 2, y: (fork.y + tip.y) / 2 + len * 0.14 },
        to: tip,
        w0: limb.w1 * 0.85,
        w1: tipW(idea),
      });
    });
  }
}

/** The bend of wood leaving the ground: down first, then out — the way a
 *  root leaves a trunk, and what keeps neighbours apart near the foot. */
function dive(from: Pt, to: Pt): Pt {
  return { x: from.x + (to.x - from.x) * 0.2, y: from.y + (to.y - from.y) * 0.85 };
}

/**
 * Relation lines in a forest run under it, not across it: down from each
 * idea, along a lane below the deepest root, and back up. Straight down from
 * a tip is clear of wood (see `layRoots`), so a line never passes through a
 * root, a tree, or the sky over the grass. Lines that would share a stretch
 * of lane take separate ones, the short ones nearest the roots.
 */
function routeLanes(placed: Placed, links: Link[], top: number) {
  const LANE = 14;
  const runs = links
    .filter((l) => l.kind === "related" || l.kind === "contradicts")
    .map((l) => {
      const a = l.source as Node;
      const b = l.target as Node;
      const ax = a.x ?? 0;
      const bx = b.x ?? 0;
      return { l, a, b, x0: Math.min(ax, bx), x1: Math.max(ax, bx) };
    })
    .sort((p, q) => p.x1 - p.x0 - (q.x1 - q.x0));
  const lanes: { x0: number; x1: number }[][] = [];
  for (const run of runs) {
    let k = 0;
    while (lanes[k]?.some((o) => run.x0 < o.x1 + 16 && run.x1 > o.x0 - 16)) k++;
    if (!lanes[k]) lanes[k] = [];
    lanes[k].push(run);
    const y = top + k * LANE;
    placed.lanes.set(run.l, [
      { x: run.a.x ?? 0, y: run.a.y ?? 0 },
      { x: run.a.x ?? 0, y },
      { x: run.b.x ?? 0, y },
      { x: run.b.x ?? 0, y: run.b.y ?? 0 },
    ]);
  }
  if (lanes.length && placed.extent) {
    const e = placed.extent;
    placed.extent = grow(e, e.x0, top, e.x1, top + (lanes.length - 1) * LANE + 10);
  }
}

function ruleset(width: number, style: MapStyle = "forest") {
  const tight = width < 560;
  return {
    tight,
    /** Orbit radius around a conversation. */
    orbit: tight ? 56 : 110,
    orbitGrowth: tight ? 6 : 10,
    /** How far a merely related pair sits apart. Held further out than the
     *  orbit so distance means something, and far enough that two clusters
     *  read as two rather than as one merged knot. */
    related: tight ? 100 : 260,
    /** Space reserved around a node, label included. */
    padding: tight ? 6 : 36,
    /** A label's share of that space. Almost none when labels are hidden. */
    labelShare: tight ? 0.15 : 0.6,
    /** Fitts's law, but a crowded panel needs a smaller target or every
     *  click lands on a neighbour. */
    hitRadius: tight ? 11 : 16,
    /** Nodes are drawn smaller in a panel; at full size they crowd it out.
     *  The full-page map used to take the roomy figure straight, which on a
     *  wide canvas is a field of circles with the links lost between them —
     *  so the chosen style scales it rather than the panel alone deciding. */
    nodeScale: (tight ? 0.62 : 1) * STYLE_SCALE[style],
    charge: tight ? -18 : -90,
    chargeByRadius: tight ? 4 : 10,
  };
}

/** The kinds of tree the secret forest grows. Without it, every tree is a fir. */
type TreeKind = "fir" | "acacia" | "baobab" | "oak" | "birch";
const TREE_KINDS: TreeKind[] = ["fir", "acacia", "baobab", "oak", "birch"];

/**
 * How far a tree has grown, read off how much came out of its conversation:
 * nothing yet is a seed on the ground, one idea a sprout, a few a sapling,
 * more a young tree, and a conversation that yielded a lot stands full-grown.
 */
type TreeStage = "seed" | "sprout" | "sapling" | "young" | "mature";

function stageOf(ideas: number): TreeStage {
  if (ideas === 0) return "seed";
  if (ideas === 1) return "sprout";
  if (ideas <= 3) return "sapling";
  if (ideas <= 6) return "young";
  return "mature";
}

/**
 * A conversation's tree, in world units, with its foot at the origin.
 *
 * In a forest a conversation is not a dot with a tree painted round it — it
 * *is* the tree. So the shape is built once, as paths, and the drawing, the
 * hover glow and the hit test all use those same paths: what answers to the
 * pointer is exactly what is drawn. Each piece is its own path, so pieces
 * that overlap never cancel each other out under the fill rule.
 */
interface TreeSpec {
  kind: TreeKind;
  stage: TreeStage;
  /** From the ground to the top of the crown. The node sits at the top. */
  height: number;
  halfWidth: number;
  /** Half the trunk's width at the ground, where the roots leave it. */
  trunkHalf: number;
  trunk: Path2D[];
  crown: Path2D[];
}

/** A tapered limb, from one point to another, as a closed quad. */
function limb(
  list: Path2D[],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
) {
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  const nx = -(y1 - y0) / len;
  const ny = (x1 - x0) / len;
  const p = new Path2D();
  p.moveTo(x0 + nx * w0, y0 + ny * w0);
  p.lineTo(x1 + nx * w1, y1 + ny * w1);
  p.lineTo(x1 - nx * w1, y1 - ny * w1);
  p.lineTo(x0 - nx * w0, y0 - ny * w0);
  p.closePath();
  list.push(p);
}

function oval(list: Path2D[], cx: number, cy: number, rx: number, ry: number, rot = 0) {
  const p = new Path2D();
  p.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
  list.push(p);
}

function buildTree(kind: TreeKind, ideas: number): TreeSpec {
  const stage = stageOf(ideas);
  const trunk: Path2D[] = [];
  const crown: Path2D[] = [];
  if (stage === "seed") {
    // A seed on the ground, just split, a first shoot out of it.
    oval(crown, 0, -3, 6, 3.6, -0.3);
    limb(trunk, 1, -5, 3.5, -11, 0.9, 0.5);
    return { kind, stage, height: 11, halfWidth: 7, trunkHalf: 2, trunk, crown };
  }
  if (stage === "sprout") {
    const H = 34;
    limb(trunk, 0, 0, 0, -H + 4, 1.6, 1);
    oval(crown, -6, -H + 5, 7, 3, 0.5);
    oval(crown, 6, -H + 3, 7, 3, -0.5);
    return { kind, stage, height: H, halfWidth: 13, trunkHalf: 1.6, trunk, crown };
  }
  const H =
    stage === "sapling" ? 80 : stage === "young" ? 124 : Math.min(205, 160 + (ideas - 7) * 4);
  // A sapling is the tree it will become, on thinner wood.
  const t = stage === "sapling" ? 0.7 : 1;
  switch (kind) {
    case "acacia": {
      // The savannah's: a slender trunk forking under a wide, flat umbrella.
      limb(trunk, 0, 0, 0.04 * H, -0.55 * H, 0.045 * H * t, 0.03 * H * t);
      limb(trunk, 0.04 * H, -0.55 * H, -0.28 * H, -0.84 * H, 0.028 * H * t, 0.012 * H * t);
      limb(trunk, 0.04 * H, -0.55 * H, 0.3 * H, -0.86 * H, 0.028 * H * t, 0.012 * H * t);
      limb(trunk, 0.04 * H, -0.55 * H, 0.03 * H, -0.88 * H, 0.022 * H * t, 0.01 * H * t);
      oval(crown, 0, -0.9 * H, 0.6 * H, 0.09 * H);
      oval(crown, -0.2 * H, -0.95 * H, 0.34 * H, 0.07 * H);
      oval(crown, 0.22 * H, -0.94 * H, 0.32 * H, 0.07 * H);
      return { kind, stage, height: H * 1.02, halfWidth: 0.6 * H, trunkHalf: 0.045 * H * t, trunk, crown };
    }
    case "baobab": {
      // A bottle of a trunk, with a sparse, stubby crown on top of it.
      const body = new Path2D();
      body.moveTo(-0.14 * H * t, 0);
      body.quadraticCurveTo(-0.21 * H * t, -0.35 * H, -0.08 * H * t, -0.72 * H);
      body.lineTo(0.08 * H * t, -0.72 * H);
      body.quadraticCurveTo(0.21 * H * t, -0.35 * H, 0.14 * H * t, 0);
      body.closePath();
      trunk.push(body);
      for (let j = -2; j <= 2; j++) {
        const ex = j * 0.13 * H;
        const ey = -0.9 * H + Math.abs(j) * 0.05 * H;
        limb(trunk, j * 0.03 * H, -0.7 * H, ex, ey, 0.03 * H * t, 0.012 * H * t);
        oval(crown, ex, ey - 0.03 * H, 0.09 * H, 0.06 * H);
      }
      return { kind, stage, height: H * 0.99, halfWidth: 0.36 * H, trunkHalf: 0.14 * H * t, trunk, crown };
    }
    case "oak": {
      // A broad, rounded crown on a stout trunk.
      limb(trunk, 0, 0, 0, -0.52 * H, 0.07 * H * t, 0.05 * H * t);
      limb(trunk, 0, -0.45 * H, -0.16 * H, -0.64 * H, 0.03 * H * t, 0.015 * H * t);
      limb(trunk, 0, -0.45 * H, 0.16 * H, -0.66 * H, 0.03 * H * t, 0.015 * H * t);
      oval(crown, 0, -0.64 * H, 0.32 * H, 0.27 * H);
      oval(crown, -0.25 * H, -0.54 * H, 0.2 * H, 0.17 * H);
      oval(crown, 0.26 * H, -0.56 * H, 0.2 * H, 0.17 * H);
      oval(crown, -0.11 * H, -0.8 * H, 0.22 * H, 0.19 * H);
      oval(crown, 0.12 * H, -0.79 * H, 0.2 * H, 0.19 * H);
      return { kind, stage, height: H * 0.99, halfWidth: 0.46 * H, trunkHalf: 0.07 * H * t, trunk, crown };
    }
    case "birch": {
      // Tall and slender, pale wood under a narrow crown.
      limb(trunk, 0, 0, 0.02 * H, -0.82 * H, 0.035 * H * t, 0.018 * H * t);
      oval(crown, 0.01 * H, -0.62 * H, 0.17 * H, 0.36 * H);
      oval(crown, 0.06 * H, -0.44 * H, 0.13 * H, 0.19 * H);
      return { kind, stage, height: H * 0.98, halfWidth: 0.2 * H, trunkHalf: 0.035 * H * t, trunk, crown };
    }
    default: {
      // The fir the app is named by: three overlapping tiers on a short trunk.
      const hw = 0.34 * H;
      const trunkH = 0.16 * H;
      const tw = Math.max(1.2, hw * 0.14) * t;
      const stem = new Path2D();
      stem.rect(-tw, -trunkH, tw * 2, trunkH);
      trunk.push(stem);
      const canopyH = H - trunkH;
      for (let i = 0; i < 3; i++) {
        const tier = new Path2D();
        const bottom = -H + canopyH * (0.5 + i * 0.25);
        const half = hw * (0.5 + i * 0.25);
        tier.moveTo(0, -H + canopyH * i * 0.3);
        tier.lineTo(half, bottom);
        tier.lineTo(-half, bottom);
        tier.closePath();
        crown.push(tier);
      }
      return { kind, stage, height: H, halfWidth: hw, trunkHalf: tw, trunk, crown };
    }
  }
}

/** How much each species lifts or deepens its conversation's colour. */
const CROWN_SHADE: Record<TreeKind, number> = {
  fir: 0,
  acacia: -0.08,
  baobab: 0.08,
  oak: -0.18,
  birch: 0.18,
};

/**
 * Paint a tree standing at `x`. With a colour, wood and crown in their own
 * shades of it; with `null`, the whole silhouette in the current fill — the
 * hover glow, scaled about the foot by `grow`.
 */
function paintTree(
  ctx: CanvasRenderingContext2D,
  spec: TreeSpec,
  x: number,
  color: string | null,
  grow = 1,
) {
  ctx.save();
  ctx.translate(x, 0);
  ctx.scale(grow, grow);
  if (color !== null) {
    ctx.fillStyle =
      spec.kind === "fir" ? color : spec.kind === "birch" ? "#e4dfd3" : shadeColor(color, -0.42);
  }
  for (const p of spec.trunk) ctx.fill(p);
  if (color !== null) ctx.fillStyle = shadeColor(color, CROWN_SHADE[spec.kind]);
  for (const p of spec.crown) ctx.fill(p);
  ctx.restore();
}

let hitContext: CanvasRenderingContext2D | null = null;

/** Whether a world point is on the tree standing at `x`, crown or trunk. */
function onTree(spec: TreeSpec, x: number, wx: number, wy: number): boolean {
  if (!hitContext) hitContext = document.createElement("canvas").getContext("2d");
  if (!hitContext) return false;
  const ctx = hitContext;
  const px = wx - x;
  return [...spec.crown, ...spec.trunk].some((p) => ctx.isPointInPath(p, px, wy));
}

/** A point on a quadratic curve. */
function quad(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Its derivative, for the normal a taper's width is measured along. */
function quadTangent(p0: number, p1: number, p2: number, t: number): number {
  return 2 * (1 - t) * (p1 - p0) + 2 * t * (p2 - p1);
}

/** How high a pollen stream arches over the meadow. One definition for the
 *  drawing and the hit test, or the popup answers to a curve nobody sees. */
function meadowArch(len: number, clear: number): number {
  return Math.min(96, 20 + len * 0.18 + clear);
}

/** A taper's centreline, sampled, with the half-width and normal at each point. */
function taperPoints(s: Taper, steps = 14) {
  const pts: { x: number; y: number; nx: number; ny: number; w: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const tx = quadTangent(s.from.x, s.c.x, s.to.x, t);
    const ty = quadTangent(s.from.y, s.c.y, s.to.y, t);
    const l = Math.hypot(tx, ty) || 1;
    pts.push({
      x: quad(s.from.x, s.c.x, s.to.x, t),
      y: quad(s.from.y, s.c.y, s.to.y, t),
      nx: -ty / l,
      ny: tx / l,
      w: s.w0 + (s.w1 - s.w0) * t,
    });
  }
  return pts;
}

/** Fill a taper, with a round end so joints and tips are not cut square. */
function fillTaper(ctx: CanvasRenderingContext2D, s: Taper, thicken = 1) {
  const pts = taperPoints(s);
  ctx.beginPath();
  pts.forEach((p, i) => {
    const X = p.x + p.nx * p.w * thicken;
    const Y = p.y + p.ny * p.w * thicken;
    if (i === 0) ctx.moveTo(X, Y);
    else ctx.lineTo(X, Y);
  });
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    ctx.lineTo(p.x - p.nx * p.w * thicken, p.y - p.ny * p.w * thicken);
  }
  ctx.closePath();
  ctx.fill();
  // Filled on its own: one path with both would cancel where they overlap.
  ctx.beginPath();
  ctx.arc(s.to.x, s.to.y, s.w1 * thicken, 0, Math.PI * 2);
  ctx.fill();
}

/** Shortest distance from a point to a polyline. */
function polylineDistance(pts: Pt[], px: number, py: number): number {
  if (pts.length === 1) return Math.hypot(px - pts[0].x, py - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const l2 = vx * vx + vy * vy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / l2)) : 0;
    best = Math.min(best, Math.hypot(px - a.x - vx * t, py - a.y - vy * t));
  }
  return best;
}

/** A polyline with rounded corners: the lanes under the forest. */
function strokeRoute(ctx: CanvasRenderingContext2D, pts: Pt[], radius: number) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const o = pts[i - 1];
    const p = pts[i];
    const q = pts[i + 1];
    const r = Math.min(
      radius,
      Math.hypot(p.x - o.x, p.y - o.y) / 2,
      Math.hypot(q.x - p.x, q.y - p.y) / 2,
    );
    ctx.arcTo(p.x, p.y, q.x, q.y, r);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

/**
 * A root that is an idea: wood from the fork (or the foot) to the idea,
 * shaded from the tree's colour to the idea's, ending blunt at the idea's own
 * width. The longer ones carry two short rootlets, angled toward the tip, so
 * the system reads as grown rather than drawn. `k` is the zoom, for hairlines.
 */
function drawRoot(
  ctx: CanvasRenderingContext2D,
  root: ForestRoot,
  wood: string,
  tip: string,
  k: number,
  thicken = 1,
) {
  const grad = ctx.createLinearGradient(root.from.x, root.from.y, root.to.x, root.to.y);
  grad.addColorStop(0, wood);
  grad.addColorStop(1, tip);
  ctx.fillStyle = grad;
  fillTaper(ctx, root, thicken);

  const len = Math.hypot(root.to.x - root.from.x, root.to.y - root.from.y);
  if (len < 60) return;
  ctx.strokeStyle = wood;
  ctx.lineWidth = Math.max(0.7, 0.9 / k);
  ctx.lineCap = "round";
  for (let j = 0; j < 2; j++) {
    const t = 0.4 + j * 0.28;
    const x = quad(root.from.x, root.c.x, root.to.x, t);
    const y = quad(root.from.y, root.c.y, root.to.y, t);
    const tx0 = quadTangent(root.from.x, root.c.x, root.to.x, t);
    const ty0 = quadTangent(root.from.y, root.c.y, root.to.y, t);
    const l = Math.hypot(tx0, ty0) || 1;
    const tx = tx0 / l;
    const ty = ty0 / l;
    const side = (root.seed + j) % 2 === 0 ? 1 : -1;
    const reach = 6 + len * 0.05;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x - ty * side * reach * 0.6 + tx * reach * 0.2,
      y + tx * side * reach * 0.6 + ty * reach * 0.2,
      x - ty * side * reach + tx * reach * 0.5,
      y + tx * side * reach + ty * reach * 0.5,
    );
    ctx.stroke();
  }
}

/**
 * One petal: an ellipse lying along a ray from the flower's centre.
 *
 * The sunflower's head and the idea-petals fallen around it are the same
 * flower, so both are built by this one function. Drawn any other way the
 * ideas read as leaves, or as a different plant entirely.
 */
function drawPetal(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  angle: number,
  mid: number,
  major: number,
  minor: number,
  color: string,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(mid, 0, major, minor, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A sunflower's stalk and leaves, from the grass up to its head. World units. */
function drawStalk(
  ctx: CanvasRenderingContext2D,
  x: number,
  ground: number,
  headY: number,
  disc: number,
  stem: string,
  seed: number,
) {
  const top = headY + disc * 0.5;
  const len = ground - top;
  const bow = (seed % 2 === 0 ? 1 : -1) * Math.min(14, len * 0.06);
  const cx = x + bow;
  const cy = ground - len * 0.5;
  ctx.strokeStyle = stem;
  ctx.lineCap = "round";
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.moveTo(x, ground);
  ctx.quadraticCurveTo(cx, cy, x, top);
  ctx.stroke();
  // A leaf or two, angled off the stalk, so it reads as a plant.
  ctx.fillStyle = stem;
  for (let i = 0; i < 2; i++) {
    const t = 0.3 + i * 0.22;
    const px = quad(x, cx, x, t);
    const py = quad(ground, cy, top, t);
    const dir = (i + seed) % 2 === 0 ? 1 : -1;
    ctx.beginPath();
    ctx.ellipse(px + dir * 13, py - 4, 14, 5, dir * -0.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The seeded centre of a sunflower, drawn over the inner ends of its petals. */
function drawDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.fillStyle = "#5a4326";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#3f2f1c";
  ctx.beginPath();
  ctx.arc(x, y, r * 0.74, 0, Math.PI * 2);
  ctx.fill();
  // Seeds on the golden angle, the way a real head packs them.
  ctx.fillStyle = "#7a5a32";
  for (let i = 1; i < 40; i++) {
    const rr = r * 0.9 * Math.sqrt(i / 40);
    const a = i * 2.399963;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, r * 0.045, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Grass along the ground: blades, each wide at the root and tapering to a
 * point, swaying together. In world units, so the floor zooms with the trees
 * standing on it. Pulled far back the blades would be finer than a pixel
 * apart, so every other one is dropped — by index, so those left stay put.
 */
function drawGrass(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  ground: number,
  color: string,
  t: number,
  k: number,
) {
  const STEP = 9;
  let every = 1;
  while (STEP * every * k < 3) every *= 2;
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.5;
  for (let i = Math.floor(x0 / STEP / every) * every; i * STEP <= x1; i += every) {
    const x = i * STEP;
    const seed = (i * 2654435761) >>> 0;
    const h = 8 + (seed % 12);
    const lean = (seed % 5) - 2;
    const sway = Math.sin(t * 0.9 + x * 0.045) * 2.6;
    const tipX = x + lean + sway;
    const tipY = ground - h;
    const halfW = 1.1 + (seed % 3) * 0.5;
    ctx.beginPath();
    ctx.moveTo(x - halfW, ground);
    ctx.quadraticCurveTo(x - halfW * 0.4 + sway * 0.3, ground - h * 0.55, tipX, tipY);
    ctx.quadraticCurveTo(x + halfW * 0.4 + sway * 0.3, ground - h * 0.55, x + halfW, ground);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** A bee, small: a striped body between two translucent wings. */
function drawBee(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, scale: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.save();
  ctx.globalAlpha *= 0.65;
  ctx.fillStyle = "#e8eef5";
  ctx.beginPath();
  ctx.ellipse(0, -5, 6, 3.4, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 5, 6, 3.4, 0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#e6b13c";
  ctx.beginPath();
  ctx.ellipse(0, 0, 7, 4.2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2c2722";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(-2.5, -4);
  ctx.lineTo(-2.5, 4);
  ctx.moveTo(2, -3.6);
  ctx.lineTo(2, 3.6);
  ctx.stroke();
  ctx.fillStyle = "#2c2722";
  ctx.beginPath();
  ctx.arc(7, 0, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * A conversation in the galaxy, drawn as the star its ideas orbit.
 *
 * The type is read off how much came out of the conversation: a quiet one is a
 * dwarf, a busy one a giant, and one that yielded nothing at all is a failed
 * star — a cold cinder rather than a sun. The colour of a conversation is the
 * same accent everywhere else on the map, so a star keeps it; what changes
 * with size is its heat, its glow and its size on the ring.
 */
function drawStar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  seed: number,
  weight: number,
) {
  const failed = weight <= 0;
  let core = "#fff7db";
  let mid = "#ffd36a";
  let edge = "#f0a33a";
  let glow = "rgba(255, 199, 92, 0.30)";
  let corona = 1.7;
  if (failed) {
    core = "#9b8a80";
    mid = "#6d5c54";
    edge = "#443832";
    glow = "rgba(120, 96, 86, 0.16)";
    corona = 1.2;
  } else if (weight <= 2) {
    core = "#ffd8bd";
    mid = "#ff8a4c";
    edge = "#c8472a";
    glow = "rgba(255, 116, 62, 0.30)";
    corona = 1.45;
  } else if (weight <= 6) {
    // Main sequence: the defaults above are already a yellow sun.
  } else if (weight <= 12) {
    core = "#fff0c0";
    mid = "#ffb24d";
    edge = "#e07b2a";
    glow = "rgba(255, 168, 74, 0.38)";
    corona = 2;
  } else {
    core = "#ffe2b4";
    mid = "#ff7a4a";
    edge = "#b83a2a";
    glow = "rgba(255, 92, 60, 0.44)";
    corona = 2.4;
  }
  // A little per-node wobble, so two conversations of the same size are not
  // the same star twice: the size class is set by what came out of it, and the
  // seed gives each one its own figure within that class.
  const wobble = 1 + ((seed % 5) - 2) * 0.045;
  const R = Math.max(1.4, r * (failed ? 0.82 : 1) * wobble);
  const haloReach = R * corona;

  if (!failed) {
    const halo = ctx.createRadialGradient(x, y, R * 0.35, x, y, haloReach);
    halo.addColorStop(0, glow);
    halo.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, haloReach, 0, Math.PI * 2);
    ctx.fill();
  }

  const body = ctx.createRadialGradient(x - R * 0.3, y - R * 0.35, R * 0.08, x, y, R);
  body.addColorStop(0, core);
  body.addColorStop(0.55, mid);
  body.addColorStop(1, edge);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fill();

  // No surface mottling: hard-edged spots on a glowing body read as grey
  // discs stuck to the sun, not as texture.
  if (failed) {
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = Math.max(0.6, R * 0.14);
    ctx.beginPath();
    ctx.arc(x, y, R * 0.98, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/**
 * A node in the secret galaxy: a world with a lit side.
 *
 * The colour is never replaced — it is the subject's colour, used as the
 * planet's ground. On top of that each idea gets a skin generated from its own
 * id: a gas giant with bands and a storm, a terran world with continents and
 * ice, a cratered rock, an ice world, an ocean or lava world, some with a ring.
 * The seed decides, so a planet is the same world every frame and no two ideas
 * come out looking alike. Drawn into a clipped circle, so nothing spills past
 * the node it belongs to.
 */
/** Pull a colour toward white (f > 0) or black (f < 0) by a fraction. */
function shadeColor(hex: string, f: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const t = f < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(f));
  const mix = (c: number) => Math.round(c + (t - c) * p);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function drawWorld(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  seed: number,
  isMoon: boolean,
) {
  if (r < 1.2) return;

  // A tiny deterministic generator, so each world is the same world every
  // frame while no two are built the same way.
  let s = (seed >>> 0) + 0x9e3779b9;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);

  // No dark blotches anywhere — craters and continents drawn as black
  // ellipses at this size read as smudges on the glass, not as geography.
  // A moon is bare rock, lit.
  if (!isMoon) {
    const kind = Math.floor(rnd() * 5);
    if (kind === 0) {
      // Gas giant: bands, plus the odd storm.
      const bands = 4 + Math.floor(rnd() * 5);
      for (let i = 0; i < bands; i++) {
        const yy = y - r + rnd() * r * 2;
        ctx.globalAlpha = 0.06 + rnd() * 0.1;
        ctx.fillStyle = rnd() < 0.5 ? "#000" : "#fff";
        ctx.beginPath();
        ctx.ellipse(x, yy, r * 1.25, r * (0.08 + rnd() * 0.12), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (rnd() < 0.6) {
        ctx.globalAlpha = 0.2 + rnd() * 0.15;
        // The storm is the world's own colour, deepened — a paint from
        // another palette would make the planet stop being its tag's colour.
        ctx.fillStyle = shadeColor(color, rnd() < 0.5 ? -0.3 : -0.5);
        ctx.beginPath();
        ctx.ellipse(
          x - r * 0.3 + rnd() * r * 0.6,
          y - r * 0.2 + rnd() * r * 0.4,
          r * (0.22 + rnd() * 0.2),
          r * (0.14 + rnd() * 0.12),
          rnd() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    } else if (kind === 1) {
      // Terran: polar ice.
      if (rnd() < 0.7) {
        ctx.globalAlpha = 0.4;
        // Polar ice is the world's colour lifted toward white, so the caps
        // brighten the planet rather than repaint it.
        ctx.fillStyle = shadeColor(color, 0.6);
        ctx.beginPath();
        ctx.ellipse(x, y - r * 0.82, r * (0.5 + rnd() * 0.3), r * (0.2 + rnd() * 0.15), 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 2) {
      // Rock: bare, the lighting alone.
    } else if (kind === 3) {
      // Ice: bright caps.
      ctx.globalAlpha = 0.5 + rnd() * 0.2;
      ctx.fillStyle = "#f4f8ff";
      ctx.beginPath();
      ctx.ellipse(x, y - r * 0.8, r * (0.55 + rnd() * 0.3), r * (0.22 + rnd() * 0.15), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.82, r * (0.45 + rnd() * 0.3), r * (0.2 + rnd() * 0.12), 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Ocean or lava: one bright pool of the one or the other — the world's
      // own colour, lifted or sunk, never a different hue.
      ctx.globalAlpha = 0.2 + rnd() * 0.2;
      ctx.fillStyle = shadeColor(color, rnd() < 0.5 ? 0.5 : -0.3);
      ctx.beginPath();
      ctx.ellipse(
        x - r * 0.3 + rnd() * r * 0.6,
        y - r * 0.2 + rnd() * r * 0.4,
        r * (0.3 + rnd() * 0.3),
        r * (0.2 + rnd() * 0.25),
        (rnd() - 0.5) * 1.5,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  const light = ctx.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.05, x, y, r * 1.15);
  light.addColorStop(0, "rgba(255,255,255,0.5)");
  light.addColorStop(0.32, "rgba(255,255,255,0.02)");
  light.addColorStop(0.72, "rgba(0,0,0,0.16)");
  light.addColorStop(1, "rgba(0,0,0,0.6)");
  ctx.globalAlpha = 1;
  ctx.fillStyle = light;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();

  // A ring, for the worlds random enough to have one. Outside the clip on
  // purpose — a ring drawn inside it would stop at the planet's limb.
  if (!isMoon && r > 2.5 && rnd() < 0.35) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rnd() - 0.5) * Math.PI);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * (1.4 + rnd() * 0.5), r * (0.22 + rnd() * 0.2), 0, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(240, 226, 190, 0.5)";
    ctx.lineWidth = Math.max(1, r * (0.1 + rnd() * 0.12));
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * The whole tree a node belongs to: the conversation at its top and every idea
 * it grew. Pointing at any part of a forest tree lights the whole root system,
 * so a claim is read in the context of what it came from rather than alone.
 */
function forestCluster(hover: Node | null, links: Link[], style: MapStyle): Set<Node> | null {
  if (!hover || (style !== "forest" && style !== "sunflower")) return null;
  let hub: Node | null = hover.data.kind === "conversation" ? hover : null;
  if (!hub) {
    for (const l of links) {
      if (l.kind === "from" && (l.target as Node) === hover) {
        hub = l.source as Node;
        break;
      }
    }
  }
  if (!hub) return null;
  const set = new Set<Node>([hub]);
  for (const l of links) {
    if (l.kind === "from" && (l.source as Node) === hub) set.add(l.target as Node);
  }
  return set;
}


/** And how tall a sunflower stands. Taller, because its head is a marker. */
const SUNFLOWER_HEIGHT = 210;

/** How many ideas one ring of petals holds before a second opens behind it. */
const PETALS_PER_RING = 16;

/**
 * A sunflower per conversation, its ideas the petals of that flower.
 *
 * Every petal is laid out once, in world units, from under the rim of the
 * disc outward. The meadow used to re-place its petals every frame against
 * the head's size on screen, which zoomed at a different rate from the space
 * around it — so petals drifted off their flower. Sized from the disc and
 * drawn under the same transform, a petal cannot leave it.
 *
 * A head with few ideas still has a full set: the slots no idea takes get
 * plain petals. A crowded one grows a second ring behind the first, offset
 * half a petal so each shows between its neighbours in front.
 */
function arrangeSunflowers(nodes: Node[], links: Link[], spread: MapSpread = "balanced"): Placed {
  const { hubs, ideasOf, loose } = hubsAndTheirIdeas(nodes, links);
  const placed = emptyPlaced();
  const inner = SPREAD_INNER[spread];
  const gap = 60 * SPREAD_GAP[spread];
  const heads = hubs.map((hub) => {
    const ideas = ideasOf.get(hub) ?? [];
    const rings = Math.max(1, Math.ceil(ideas.length / PETALS_PER_RING));
    const perRing = Math.max(1, Math.ceil(ideas.length / rings));
    const slots = Math.max(12, perRing);
    // Round enough that every slot's petal has its own arc of rim.
    const disc = Math.max(22, (slots * 8.5) / Math.PI);
    const len = Math.min(64, Math.max(36, disc * 1.25)) * inner;
    const halfW = Math.min(11, (Math.PI * disc) / slots);
    const reach = disc * 0.8 + len * (1 + 0.32 * (rings - 1)) + 4;
    return { hub, ideas, perRing, slots, disc, len, halfW, reach, half: Math.max(reach, 40) };
  });

  const total = heads.reduce((s, f) => s + f.half * 2, 0) + gap * Math.max(0, heads.length - 1);
  let cursor = -total / 2;
  const headY = -SUNFLOWER_HEIGHT;
  for (const f of heads) {
    const x = cursor + f.half;
    cursor += f.half * 2 + gap;
    f.hub.x = x;
    f.hub.y = headY;
    f.hub.fx = x;
    f.hub.fy = headY;
    const step = (Math.PI * 2) / f.slots;
    // A turn of its own, so a meadow is not one flower stamped in a row.
    const turn = -Math.PI / 2 + ((hashText(f.hub.data.id) % 100) / 100) * step;
    const taken = new Set<number>();
    f.ideas.forEach((idea, k) => {
      const ring = Math.floor(k / f.perRing);
      const inRing = Math.min(f.perRing, f.ideas.length - ring * f.perRing);
      const slot = Math.round(((k - ring * f.perRing) * f.slots) / inRing) % f.slots;
      if (ring === 0) taken.add(slot);
      const petal: Petal = {
        hub: f.hub,
        angle: turn + (slot + ring * 0.5) * step,
        inner: f.disc * 0.8,
        len: f.len * (1 + 0.32 * ring),
        halfW: f.halfW * (1 - 0.1 * ring),
        ring,
      };
      placed.petals.set(idea, petal);
      placed.outward.set(idea, petal.angle);
      // The node sits on the part of the petal that shows: the middle of one
      // in front, the tip of one behind.
      const at = petal.inner + petal.len * (ring === 0 ? 0.55 : 0.84);
      idea.x = x + Math.cos(petal.angle) * at;
      idea.y = headY + Math.sin(petal.angle) * at;
      idea.fx = idea.x;
      idea.fy = idea.y;
    });
    const filler: Flower["filler"] = [];
    for (let s = 0; s < f.slots; s++) {
      if (!taken.has(s)) filler.push({ angle: turn + s * step, len: f.len * 0.8, halfW: f.halfW * 0.9 });
    }
    placed.flowers.set(f.hub, { disc: f.disc, filler, reach: f.reach });
    placed.extent = grow(placed.extent, x - f.half, headY - f.reach, x + f.half, 0);
  }

  // Ideas whose conversation is gone stand in the grass past the last flower.
  loose.forEach((n, i) => {
    n.x = total / 2 + gap + i * 50 * inner;
    n.y = -30;
    n.fx = n.x;
    n.fy = n.y;
    placed.extent = grow(placed.extent, n.x - 12, n.y - 12, n.x + 12, n.y + 12);
  });
  return placed;
}

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

/** Run a simulation toward rest for at most `budget` milliseconds. Whatever
 *  is left it finishes live, a tick per frame, instead of in one blocking go. */
function settleFor(sim: Simulation<Node, Link>, budget: number) {
  const t0 = performance.now();
  while (sim.alpha() > sim.alphaMin() && performance.now() - t0 < budget) sim.tick();
}

/** Each conversation with the ideas that came from it, hub first. */
function clusterGroups(links: Link[]): Node[][] {
  const byHub = new Map<Node, Node[]>();
  for (const l of links) {
    if (l.kind !== "from") continue;
    const hub = l.source as Node;
    const list = byHub.get(hub) ?? [hub];
    list.push(l.target as Node);
    byHub.set(hub, list);
  }
  return [...byHub.values()];
}

/**
 * Keep each conversation and its ideas clear of the next, as wholes.
 *
 * The spacing setting used to multiply the push between every pair of nodes,
 * so "Roomy" mostly flung a conversation's own ideas away from it and left
 * them reading as strays. This moves whole clusters instead: every member of
 * one gets the same shove, so the gap *between* conversations is what the
 * setting sets, and each cluster keeps its shape.
 */
function forceClusters(groups: Node[][], gapOf: () => number) {
  return (alpha: number) => {
    const gap = gapOf();
    const info = groups.map((g) => {
      let cx = 0;
      let cy = 0;
      for (const n of g) {
        cx += n.x ?? 0;
        cy += n.y ?? 0;
      }
      cx /= g.length;
      cy /= g.length;
      let r = 0;
      for (const n of g) r = Math.max(r, Math.hypot((n.x ?? 0) - cx, (n.y ?? 0) - cy) + n.r);
      return { g, cx, cy, r };
    });
    for (let i = 0; i < info.length; i++) {
      for (let j = i + 1; j < info.length; j++) {
        const a = info[i];
        const b = info[j];
        const d = Math.hypot(b.cx - a.cx, b.cy - a.cy) || 1;
        const need = a.r + b.r + gap;
        if (d >= need) continue;
        const push = ((need - d) / d) * alpha * 0.3;
        const dx = (b.cx - a.cx) * push;
        const dy = (b.cy - a.cy) * push;
        for (const n of a.g) {
          n.vx = (n.vx ?? 0) - dx;
          n.vy = (n.vy ?? 0) - dy;
        }
        for (const n of b.g) {
          n.vx = (n.vx ?? 0) + dx;
          n.vy = (n.vy ?? 0) + dy;
        }
      }
    }
  };
}
/** What each spacing multiplies the room *between* clusters by — trees in a
 *  forest, flowers in a meadow, systems in a galaxy. Strong, because that gap
 *  is what the setting is named for, and the things either side of it keep
 *  their size, so it shows as distance even once the map is framed. */
const SPREAD_GAP: Record<MapSpread, number> = {
  loose: 2.6,
  balanced: 1,
  tight: 0.3,
};

/** And the room inside one: between a tree's root tips, a system's rings, a
 *  flower's petals. Gentle, so a tree keeps its shape at every setting. */
const SPREAD_INNER: Record<MapSpread, number> = {
  loose: 1.25,
  balanced: 1,
  tight: 0.8,
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
  /** The sunflower each idea petal grew from, so a petal can lie along the
   *  line out from its centre rather than pointing at nothing. */
  const parentRef = useRef(new Map<Node, Node>());
/** How far each petal has eased out of its flower. A number in a ref rather
    *  than on the node, because it is animation state and not part of the map. */
  const petalPopRef = useRef(new Map<Node, number>());
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const viewRef = useRef({ x: 0, y: 0, scale: 1 });
  const hoverRef = useRef<Node | null>(null);
  /** How far the galaxy has turned, in seconds of turning. It only advances
   *  while nothing is pointed at or dragged — see the draw loop. */
  const galaxyClockRef = useRef(0);
  const galaxyFrameRef = useRef<number | null>(null);
  /** Bees drifting through the sunflower meadow's pollen streams. Kept in a
   *  ref because they are spawned, moved and retired inside the draw loop. */
  const beeRef = useRef<{ link: Link; t: number; speed: number; phase: number }[]>([]);
  const beeSpawnRef = useRef(0);
  const beeFrameRef = useRef<number | null>(null);
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
  /** A sunflower being carried by its stem, and where along it it was held. */
  const dragFlowerRef = useRef<{ hub: Node; dx: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const frameRef = useRef(0);
  const startedRef = useRef(performance.now());
  /** The root font size, and when it was last read. */
  const rootPxRef = useRef({ px: 16, at: -Infinity });

  const [hovered, setHovered] = useState<GraphNode | null>(null);
  /** Where the hovered node sat, so the pointer can travel out to its notes. */
  const keepAliveRef = useRef<{ x: number; y: number; r: number } | null>(null);
  const [hoverAt, setHoverAt] = useState<
    { x: number; y: number; r: number; color: string; below: boolean; disc: boolean } | null
  >(null);
  const [empty, setEmpty] = useState(false);
  const [legend, setLegend] = useState<[string, string][]>([]);
  /** Held in a ref rather than state: the draw loop and the hit test both read
   *  it every frame, and a re-render per frame is not the way to tell them. */
  const styleRef = useRef<MapStyle>("forest");
  /** The galaxy's hidden texture layer. Read every frame; off unless Settings
   *  turned it on. */
  const secretRef = useRef(false);
  /** The forest's hidden species. A rebuild, not paint: see `arrangeForest`. */
  const secretTreesRef = useRef(false);
  /** What an arranged style worked out: rings to draw, orbits to turn,
   *  trunks to stand. Empty under `nodes`, which is laid out by force. */
  const placedRef = useRef<Placed>(NOTHING_PLACED);
  /** Answers and the claims they hang from. Applied every frame rather than
   *  once: a galaxy's planets turn, and a force layout's are still moving. */
  const moonsRef = useRef<Moon[]>([]);
  /** How many visible ideas each conversation has, by node id. Read by the
   *  galaxy to decide a star's type, so a conversation whose ideas are all
   *  archived reads the same as one that never produced any. */
  const ideaCountRef = useRef(new Map<string, number>());
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
  /** Whether nodes may be dragged out of place. The handlers read the ref;
   *  the state is for the toggle that shows what is set. */
  const [locked, setLocked] = useState(false);
  const lockRef = useRef(false);
  const [showArrange, setShowArrange] = useState(false);
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
    const applyLock = (on: boolean | undefined) => {
      if (!alive || on === undefined) return;
      lockRef.current = on;
      setLocked(on);
    };
    const applySecret = (on: boolean | undefined) => {
      if (!alive) return;
      secretRef.current = !!on;
    };
    // The secret forest changes what is built, not only its paint, so it
    // rebuilds when it flips while a forest is on screen.
    const applyTrees = (on: boolean | undefined) => {
      if (!alive || secretTreesRef.current === !!on) return;
      secretTreesRef.current = !!on;
      if (styleRef.current === "forest") buildRef.current();
    };
    // The first read is not a change, so it sets the ref and rebuilds once —
    // the initial build may already have run under the default.
    void getSettings().then((st) => {
      if (!alive) return;
      apply(st.map_style, st.map_spread ?? "balanced");
      applyLock(st.map_lock_nodes);
      applySecret(st.secret_galaxy);
      applyTrees(st.secret_trees);
    });
    const un = onSettingsChanged((st) => {
      apply(st.map_style, st.map_spread ?? "balanced");
      applyLock(st.map_lock_nodes);
      applySecret(st.secret_galaxy);
      applyTrees(st.secret_trees);
    });
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
  /** Mirror of `edgeHover` for the draw loop and the handlers, which read it
   *  every frame; the state is for the popup that renders it. */
  const edgeHoverRef = useRef<{
    kind: "related" | "contradicts";
    a: GraphNode;
    b: GraphNode;
    reasoning?: string;
    x: number;
    y: number;
  } | null>(null);
  /** Where the pointer last stood over the canvas, in canvas pixels. The
   *  galaxy turns without any pointer movement, so the edge hover has to be
   *  re-tested against this between moves — see the draw loop. */
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
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
   * World to screen: one scale and one offset, for positions and sizes alike.
   *
   * The force layout used to breathe — positions took a factor on top of the
   * zoom that sizes did not — and arranged shapes were rebuilt in screen
   * pixels with their own clamps. So nothing kept its proportions as the
   * view moved. One affine map, applied the same way to everything, is what
   * makes the map a picture you zoom rather than a set of things that resize.
   */
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

    // The secret galaxy is a night sky: pitch black, with stars fixed behind
    // the map. The worlds turn in front of them — a sky that moved with the
    // pan would read as wallpaper; one that stays still reads as distance.
    if (styleRef.current === "galaxy" && secretRef.current) {
      ctx.fillStyle = "#04040a";
      ctx.fillRect(0, 0, w, h);
      let s = 0x1f2e3d;
      const rnd = () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
      };
      const count = Math.round((w * h) / 9000);
      const t = performance.now() / 1000;
      for (let i = 0; i < count; i++) {
        const x = rnd() * w;
        const y = rnd() * h;
        const big = rnd() < 0.08;
        const phase = rnd() * Math.PI * 2;
        const speed = 0.3 + rnd() * 0.7;
        const twinkle = 0.55 + 0.45 * Math.sin(t * speed + phase);
        ctx.globalAlpha = (big ? 0.9 : 0.45) * twinkle;
        ctx.fillStyle = "#f5f1e6";
        ctx.beginPath();
        ctx.arc(x, y, big ? 1.4 : 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // A click on the map travels the view to what was clicked. Retargeted
    // each frame rather than aimed once, because the node is still drifting.
    const travel = travelRef.current;
    if (travel) {
      const t = Math.min(1, (performance.now() - travel.t0) / 460);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const scale = travel.fromScale + (travel.toScale - travel.fromScale) * e;
      const v = viewRef.current;
      v.scale = scale;
      // Aimed at where the node was when it was clicked, not at where it is
      // this frame. Re-aiming every frame chased a target the simulation was
      // still moving, and easing toward a moving point oscillates — which is
      // what the shaking was. The node is pinned for the duration instead, so
      // the destination and the thing at it agree.
      v.x = travel.fromX + (-travel.toX * scale - travel.fromX) * e;
      v.y = travel.fromY + (-travel.toY * scale - travel.fromY) * e;
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
    // In a forest, the whole tree under the pointer is what is being pointed
    // at — a claim and the conversation it grew from are one thing.
    const cluster = forestCluster(hover, linksRef.current, styleRef.current);
    // A galaxy turns. Inner rings go round faster than outer ones, which is
    // what a galaxy actually does and what keeps the rings legible as rings
    // rather than as a wheel of spokes.
    //
    // Pointing at anything stops the whole galaxy, not just the node under
    // the pointer. Holding only that one still while its ring kept turning
    // pulled it off its orbit: the radius it was re-read at on release was
    // wherever it had been nudged to, so nodes came away snagged, bunched up
    // on their ring or sitting off it. With one clock that simply pauses,
    // every node stays exactly on its orbit and resumes from where it was.
    const placed = placedRef.current;
    const now = performance.now() / 1000;
    const last = galaxyFrameRef.current;
    galaxyFrameRef.current = now;
    let turned = false;
    if (
      !hoverRef.current &&
      !dragNodeRef.current &&
      !edgeHoverRef.current &&
      last !== null
    ) {
      // Capped, so a tab that slept does not jump the galaxy a quarter turn.
      const step = Math.min(0.1, now - last);
      galaxyClockRef.current += step;
      turned = step > 0;
    }
    if (styleRef.current === "galaxy" && placed.orbits.length) {
      const t = galaxyClockRef.current;
      for (const o of placed.orbits) {
        // Slow. A galaxy that visibly races is a loading spinner; this should
        // read as drift you notice only if you watch for it.
        const angle = o.angle + (t * 7) / o.radius;
        o.node.x = (o.hub.x ?? 0) + Math.cos(angle) * o.radius;
        o.node.y = (o.hub.y ?? 0) + Math.sin(angle) * o.radius;
        o.node.fx = o.node.x;
        o.node.fy = o.node.y;
      }
      // The sky turned this frame, so a line that sat under the pointer when
      // it last moved has moved too. The hover test answers to movement, and
      // the map here moves without any — re-aim the test at where the pointer
      // rests, so a contradiction can be pointed at and held, not chased.
      const at = pointerRef.current;
      if (turned && at && !hoverRef.current && !dragNodeRef.current && !travelRef.current) {
        const edge = edgesReadable() ? edgeAt(at.x, at.y) : null;
        const was = edgeHoverRef.current;
        if (!!edge !== !!was) {
          if (edge) {
            const next = {
              kind: edge.kind as "related" | "contradicts",
              a: (edge.source as Node).data,
              b: (edge.target as Node).data,
              reasoning: edge.reasoning,
              x: at.x,
              y: at.y,
            };
            edgeHoverRef.current = next;
            setEdgeHover(next);
          } else {
            edgeHoverRef.current = null;
            setEdgeHover(null);
          }
        }
      }
    }

    // Whatever moved the planets this frame, the moons follow.
    settleMoons(moonsRef.current, hoverRef.current);

    const style = styleRef.current;
    const k = viewRef.current.scale;
    /**
     * Paint in world units. The arranged shapes — roots, lanes, grass,
     * flowers — are drawn under one transform, so they zoom as one picture: a
     * tree and the gap beside it grow at the same rate. Anything meant as a
     * hairline divides its width by `k`.
     */
    const inWorld = (paint: () => void) => {
      const v = viewRef.current;
      ctx.save();
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (v.x + w / 2), dpr * (v.y + h / 2));
      paint();
      ctx.restore();
    };
    const worldLeft = (-w / 2 - viewRef.current.x) / k;
    const worldRight = (w / 2 - viewRef.current.x) / k;

    const traced = tracedRef.current;
    const isTraced = (n: Node) => traced !== null && n.data.idea_id === traced;
    const inFocus = (n: Node) =>
      !focus ||
      (n.data.kind !== "conversation" && n.data.category === focus) ||
      n === hover ||
      isTraced(n) ||
      (cluster?.has(n) ?? false);

    // The rings themselves, faint, so a shared orbit reads as one thing.
    // In the simplified map the ring is plainer: it is what joins a
    // conversation's ideas, not a hint of an orbit.
    if (style === "galaxy" || style === "simplified") {
      ctx.strokeStyle = style === "galaxy" ? C.related : C.edge;
      ctx.globalAlpha = style === "galaxy" ? 0.14 : 0.7;
      ctx.lineWidth = 1;
      for (const ring of placed.rings) {
        const centre = toScreen(ring.hub, w, h);
        const r = ring.radius * k;
        if (r < 2 || r > 4000) continue;
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // The forest floor and everything under it.
    if (style === "forest") {
      inWorld(() => {
        // Relation lines first, beneath everything: down from each idea, along
        // a lane under the deepest root, and back up — never across the grass,
        // a tree, or another tree's roots.
        for (const [link, route] of placed.lanes) {
          const a = link.source as Node;
          const b = link.target as Node;
          ctx.globalAlpha = !focus || inFocus(a) || inFocus(b) ? 1 : 0.18;
          ctx.strokeStyle = link.kind === "contradicts" ? C.contradicts : C.related;
          ctx.lineWidth = 1.6 / k;
          ctx.setLineDash([4 / k, 4 / k]);
          strokeRoute(ctx, route, 10);
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = C.related;
        ctx.lineWidth = 1 / k;
        ctx.beginPath();
        ctx.moveTo(worldLeft, 0);
        ctx.lineTo(worldRight, 0);
        ctx.stroke();
        ctx.globalAlpha = 1;
        // Grass along the forest floor, the meadow's own ground cover growing
        // under the trees, so the rule across the map reads as a floor.
        drawGrass(ctx, worldLeft, worldRight, 0, C.stem, performance.now() / 1000, k);
        // Pointing at any part of a tree lights its wood: the limb a root
        // hangs from, and the root itself, lifted and thickened — the root is
        // the idea, so its highlight runs from the trunk to the tip.
        for (const limb of placed.limbs) {
          const pointed =
            hover === limb.hub || limb.ideas.some((i) => hover === i || isTraced(i));
          const lift = pointed ? 0.3 : cluster?.has(limb.hub) ? 0.12 : 0;
          ctx.globalAlpha = !focus || limb.ideas.some(inFocus) ? 1 : 0.22;
          ctx.fillStyle = shadeColor(limb.hub.color, lift - 0.3);
          fillTaper(ctx, limb);
        }
        for (const root of placed.roots) {
          const n = root.idea;
          const pointed = hover === n || isTraced(n);
          const lift = pointed ? 0.5 : cluster?.has(n) ? 0.2 : 0;
          ctx.globalAlpha = inFocus(n) ? 1 : 0.22;
          drawRoot(
            ctx,
            root,
            shadeColor(root.hub.color, lift - 0.3),
            shadeColor(n.color, lift),
            k,
            pointed ? 1.35 : 1,
          );
        }
        // The trees, standing over their roots' feet. Pointed at, a tree
        // glows as a tree — its own silhouette, larger, behind it — never as
        // a disc laid over it.
        for (const [hub, spec] of placed.trees) {
          const x = hub.x ?? 0;
          const pointed = hover === hub || isTraced(hub);
          ctx.globalAlpha = inFocus(hub) ? 1 : 0.22;
          if (pointed || cluster?.has(hub)) {
            ctx.fillStyle = pointed ? C.hoverRing : C.halo;
            paintTree(ctx, spec, x, null, pointed ? 1.14 : 1.07);
          }
          paintTree(ctx, spec, x, hub.color);
        }
        ctx.globalAlpha = 1;
      });
    }
    // The meadow's ground is grass rather than a line. It sways, because a
    // map with bees in it should not have a still ground beneath them.
    if (style === "sunflower") {
      inWorld(() => drawGrass(ctx, worldLeft, worldRight, 0, C.stem, performance.now() / 1000, k));
    }

    const drawLink = (link: Link) => {
      const a = link.source as Node;
      const b = link.target as Node;
      const sb = toScreen(b, w, h);
      const lit = !focus || inFocus(a) || inFocus(b);
      ctx.globalAlpha = lit ? 1 : 0.18;

      // The meadow's connections are not lines but pollen: a loose stream of
      // grains with no thread under it, drifting slowly along a path that sags
      // below the flower heads — their names sit above them — and scattered
      // across that path by one wind that gusts over the whole meadow.
      if (style === "sunflower") {
        const sa = toScreen(a, w, h);
        const len = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
        const clear = chordClearance(
          sa.x,
          sa.y,
          sb.x,
          sb.y,
          new Set([a.data.id, b.data.id]),
          w,
          h,
        );
        const cx = (sa.x + sb.x) / 2;
        const cy = (sa.y + sb.y) / 2 + meadowArch(len, clear);
        const zoomW = Math.max(0.5, Math.min(1.6, k));
        ctx.fillStyle =
          link.kind === "contradicts"
            ? C.contradicts
            : link.kind === "related"
              ? C.related
              : C.pollen;
        const now = performance.now() / 1000;
        // The wind: two slow waves out of step, so it gusts and drops rather
        // than swinging like a pendulum. Shared by every stream on the map.
        const gust = Math.sin(now * 0.35) * 0.6 + Math.sin(now * 0.13 + 1.3) * 0.4;
        // Each grain is its own seeded wanderer: where along the path it is,
        // how far off the path it has been blown, how big, how it flutters.
        let s = hashText(a.data.id + "|" + b.data.id) || 1;
        const rnd = () => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
          return s / 4294967296;
        };
        const count = Math.max(12, Math.round(len / 8));
        for (let i = 0; i < count; i++) {
          const start = rnd();
          const across = (rnd() - 0.5) * 2;
          const phase = rnd() * Math.PI * 2;
          const size = 0.6 + rnd() * 0.8;
          // Slow, and the heavier grains slower still: carried, not sent.
          const t = (start + now * 0.022 * (1.2 - size * 0.3)) % 1;
          const tx = quadTangent(sa.x, cx, sb.x, t);
          const ty = quadTangent(sa.y, cy, sb.y, t);
          const tl = Math.hypot(tx, ty) || 1;
          const mid = Math.sin(t * Math.PI);
          const band = (4 + 9 * mid) * zoomW;
          const off = across * band + Math.sin(now * 0.7 + phase) * 2.5 * zoomW;
          const px = quad(sa.x, cx, sb.x, t) - (ty / tl) * off + gust * 12 * zoomW * mid;
          const py = quad(sa.y, cy, sb.y, t) + (tx / tl) * off - Math.abs(gust) * 4 * zoomW * mid;
          ctx.globalAlpha = (lit ? 0.75 : 0.12) * (0.2 + 0.8 * mid);
          ctx.beginPath();
          ctx.arc(px, py, Math.max(0.7, 1.35 * size * zoomW), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        return;
      }

      if (link.kind === "from") {
        // Simplified: a plain spoke from the conversation to each idea on
        // its ring.
        if (style === "simplified") {
          const sa = toScreen(a, w, h);
          ctx.strokeStyle = C.edge;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(sa.x, sa.y);
          ctx.lineTo(sb.x, sb.y);
          ctx.stroke();
          return;
        }
        // A branch, not a line: tapered and bowed slightly off the straight
        // join, thick where it leaves the conversation and thin where it
        // arrives at the idea, shaded from the root's colour to the idea's.
        // The bend is signed per pair so a branch keeps its side as the
        // simulation moves rather than snapping across.
        const sa = toScreen(a, w, h);
        const dx = sb.x - sa.x;
        const dy = sb.y - sa.y;
        const len = Math.hypot(dx, dy);
        if (len <= 1) return;
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
        return;
      }

      const sa = toScreen(a, w, h);
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
    };

    for (const link of linksRef.current) {
      // The forest's roots and underground lanes are drawn above, in world
      // units; only a moon's short tether is left for here. In a galaxy the
      // ring says which conversation an idea belongs to, and in the meadow
      // the petal does — drawing the join as well turns every hub into a
      // wheel of spokes. Only the ties between different flowers stream
      // pollen.
      if (style === "forest" ? link.kind !== "answers" : link.kind === "from" && style !== "nodes" && style !== "simplified") {
        continue;
      }
      drawLink(link);
    }
    ctx.globalAlpha = 1;

    // Bees. Now and then one finds a pollen stream and follows it: spawned at
    // the start of a link, carried along it, then gone. They live only in the
    // draw loop — nothing else needs to know they exist.
    if (styleRef.current === "sunflower" && linksRef.current.length) {
      const nowS = performance.now() / 1000;
      const lastBeeFrame = beeFrameRef.current;
      beeFrameRef.current = nowS;
      const dt = lastBeeFrame === null ? 0 : Math.min(0.1, nowS - lastBeeFrame);
      if (nowS - beeSpawnRef.current > 3.5 && beeRef.current.length < 7) {
        beeSpawnRef.current = nowS + Math.random() * 2.5;
        // Bees ride the streams that are drawn. A flower's petals belong to
        // their sunflower without a thread, so those ties are not drawn — and
        // a bee following an invisible line would be a bee going nowhere.
        const links = linksRef.current.filter((l) => l.kind !== "from");
        if (!links.length) {
          beeSpawnRef.current = nowS + 3.5;
        } else {
          const link = links[Math.floor(Math.random() * links.length)];
          beeRef.current.push({
            link,
            t: 0,
            // A bee rides its stream, so it travels at pollen speed — slow
            // enough that watching one is following, not tracking.
            speed: 0.05 + Math.random() * 0.08,
            phase: Math.random() * Math.PI * 2,
          });
        }
      }
      const alive: typeof beeRef.current = [];
      for (const bee of beeRef.current) {
        bee.t += bee.speed * dt;
        if (bee.t >= 1.15) continue;
        alive.push(bee);
        const p = toScreen(bee.link.source as Node, w, h);
        const q = toScreen(bee.link.target as Node, w, h);
        const t = Math.min(1, Math.max(0, bee.t));
        const ang = Math.atan2(q.y - p.y, q.x - p.x);
        const wob = Math.sin(nowS * 6 + bee.phase) * 7 * Math.sin(t * Math.PI);
        drawBee(
          ctx,
          p.x + (q.x - p.x) * t - Math.sin(ang) * wob,
          p.y + (q.y - p.y) * t + Math.cos(ang) * wob,
          ang + Math.sin(nowS * 6 + bee.phase) * 0.16,
          Math.max(0.55, Math.min(1.6, viewRef.current.scale)),
        );
      }
      ctx.globalAlpha = 1;
      beeRef.current = alive;
    }

    // The flowers, whole: stalk, petals, disc. After the pollen, so a stream
    // arriving at a petal ends under it rather than across it.
    if (style === "sunflower") {
      inWorld(() => {
        const byHub = new Map<Node, [Node, Petal][]>();
        for (const entry of placed.petals) {
          const list = byHub.get(entry[1].hub) ?? [];
          list.push(entry);
          byHub.set(entry[1].hub, list);
        }
        for (const [hub, f] of placed.flowers) {
          const hx = hub.x ?? 0;
          const hy = hub.y ?? 0;
          const hubAlpha = inFocus(hub) ? 1 : 0.22;
          ctx.globalAlpha = hubAlpha;
          if (hover === hub || cluster?.has(hub)) {
            ctx.fillStyle = hover === hub ? C.hoverRing : C.halo;
            ctx.beginPath();
            ctx.arc(hx, hy, f.reach + 6, 0, Math.PI * 2);
            ctx.fill();
          }
          drawStalk(ctx, hx, 0, hy, f.disc, C.stem, hashText(hub.data.id));
          const mine = byHub.get(hub) ?? [];
          // Eased outward while pointed at, so hovering draws a petal out of
          // its flower — but never off it: the inner end stays under the disc.
          const drawIdea = ([n, p]: [Node, Petal]) => {
            const target = hover === n || isTraced(n) ? 1 : 0;
            const was = petalPopRef.current.get(n) ?? 0;
            const pop = was + (target - was) * 0.2;
            petalPopRef.current.set(n, pop);
            ctx.globalAlpha = inFocus(n) ? 1 : 0.22;
            drawPetal(
              ctx,
              hx,
              hy,
              p.angle,
              p.inner + p.len / 2 + pop * 4,
              (p.len / 2) * (1 + pop * 0.1),
              p.halfW * (1 + pop * 0.2),
              pop > 0.5 ? shadeColor(n.color, 0.2) : n.color,
            );
          };
          // Back to front: the rings behind, the plain petals, then the front
          // ring of ideas, and the disc over all their inner ends.
          mine.filter(([, p]) => p.ring > 0).sort((x, y) => y[1].ring - x[1].ring).forEach(drawIdea);
          ctx.globalAlpha = hubAlpha * 0.6;
          for (const fp of f.filler) {
            drawPetal(ctx, hx, hy, fp.angle, f.disc * 0.8 + fp.len / 2, fp.len / 2, fp.halfW, C.petal);
          }
          mine.filter(([, p]) => p.ring === 0).forEach(drawIdea);
          ctx.globalAlpha = hubAlpha;
          drawDisc(ctx, hx, hy, f.disc);
        }
        ctx.globalAlpha = 1;
      });
    }

    for (const n of nodesRef.current) {
      const s = toScreen(n, w, h);
      const r = drawnRadius(n.r, k, w, style);
      // In a forest a conversation is its tree and an idea its root, both
      // drawn above in world units, highlight and all; in the meadow, the
      // flowers and petals. What stands loose is still a disc.
      const spec = style === "forest" ? placed.trees.get(n) : undefined;
      const drawnAbove =
        style === "sunflower"
          ? placed.petals.has(n) || placed.flowers.has(n)
          : style === "forest" && (spec !== undefined || parentRef.current.has(n));
      const midY = spec ? s.y + spec.height * k * 0.5 : s.y;
      const ringR = spec ? Math.max(spec.halfWidth, spec.height * 0.45) * k : r;
      ctx.globalAlpha = inFocus(n) ? 1 : 0.22;

      // The same ring the pointer draws, so running down the list of what was
      // taken from a conversation picks each one out on the map in turn.
      if (!drawnAbove) {
        if (hover === n || isTraced(n)) {
          ctx.beginPath();
          ctx.arc(s.x, midY, ringR + 6, 0, Math.PI * 2);
          ctx.fillStyle = C.hoverRing;
          ctx.fill();
        } else if (cluster?.has(n)) {
          ctx.beginPath();
          ctx.arc(s.x, midY, ringR + 5, 0, Math.PI * 2);
          ctx.fillStyle = C.halo;
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

      if (drawnAbove) continue;
      if (style === "galaxy") {
        // A conversation is a star whose size is how much came out of it — a
        // failed star, one that yielded nothing, is drawn cold and dark. But
        // the suns are part of the secret skin, like the worlds: without it a
        // conversation is a plain disc, so the hidden texture stays hidden.
        if (n.data.kind === "conversation") {
          if (secretRef.current) {
            drawStar(
              ctx,
              s.x,
              s.y,
              r,
              hashText(n.data.id),
              ideaCountRef.current.get(n.data.id) ?? 0,
            );
          } else {
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fillStyle = n.color;
            ctx.fill();
          }
        } else if (secretRef.current) {
          drawWorld(
            ctx,
            s.x,
            s.y,
            r,
            n.color,
            n.data.idea_id ?? n.data.session_id ?? 0,
            n.data.kind === "moon",
          );
        } else {
          ctx.beginPath();
          ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.fill();
        }
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
    const nightSky = styleRef.current === "galaxy" && secretRef.current;

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
      (compact ? 84 : 120) * Math.min(viewRef.current.scale, 2);
    // Read at most twice a second: `getComputedStyle` every frame forced a
    // style pass over the whole app sixty times a second.
    const nowMs = performance.now();
    if (nowMs - rootPxRef.current.at > 500) {
      rootPxRef.current = {
        at: nowMs,
        px: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
      };
    }
    const labelPx = (rootPxRef.current.px / 16) * 13;
    const zoomFont = Math.min(1, Math.max(0.5, Math.sqrt(viewRef.current.scale)));

    // Lay every label out first, then decide whether the set of them fits.
    type Placed = {
      n: Node;
      lines: string[];
      x: number;
      y: number;
      lineHeight: number;
      box: { x0: number; y0: number; x1: number; y1: number };
      isConversation: boolean;
      /** Font size, in pixels. */
      px: number;
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
      const isHovered = hover === n;
      // Pulled back, the card being read shrinks — text, column and box
      // together. Its column used to narrow with the zoom while the text kept
      // its size, which squashed a sentence into a tower of two-word lines.
      const px = (isConversation ? labelPx * 1.04 : labelPx) * (isHovered ? zoomFont : 1);
      ctx.font = labelFont(px, isConversation);

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
      const maxLabelWidth = isHovered
        ? Math.min(w * 0.42, 384 * zoomFont)
        : isConversation
          ? baseLabelWidth * 1.4
          : baseLabelWidth;
      const lineHeight = px * 1.3;
      const lines = wrapLines(
        ctx,
        n.data.label,
        maxLabelWidth,
        isHovered ? 8 : isConversation ? 5 : 4,
      );
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      // A label that cannot be shown whole is not shown at all. An ellipsis on
      // a map is a title admitting it is half a title — and the words that get
      // cut are as likely as not the ones the claim turns on. Whatever is
      // being pointed at, traced, or focused is the exception: that one is
      // being read on purpose, its column is wide, and something is better
      // than nothing for naming what the ring is around.
      const beingRead = isHovered || isTraced(n) || focusNodeRef.current === n;
      const truncated = lines.length > 0 && lines[lines.length - 1].endsWith("…");
      if (truncated && !beingRead) continue;
      // Beside the node, not beneath it. Underneath, a label sat on whatever
      // was below — links, roots, the next node down — and on a dense map the
      // thing being read was the thing most likely to be covered. To the
      // right it has the node's own clear space to occupy, and a column of
      // labels reads down the map rather than colliding across it.
      const gap = Math.max(4, labelPx * 0.45);
      // Beside whatever is actually drawn: a circle's edge, or a tree's
      // widest point at the height of its middle. Anchored to the node's own
      // position a tree's name floated beside its tip, level with nothing.
      const spec = styleRef.current === "forest" ? placed.trees.get(n) : undefined;
      const tree = spec ? { halfWidth: spec.halfWidth * k, height: spec.height * k } : null;
      const half = tree
        ? tree.halfWidth
        : // A sunflower's name sits beside the *flower* — head and petals, not
          // the bare node radius the head is drawn over.
          styleRef.current === "sunflower" && isConversation
          ? (placed.flowers.get(n)?.reach ?? n.r) * viewRef.current.scale
          : r;
      // The hovered card is several times wider than an ordinary label, so
      // near the right edge it ran off the canvas and took the end of the
      // claim with it. Only the card flips: an ordinary label is narrow
      // enough that the column reads better staying on one side.
      const pad = Math.max(4, px * 0.85);
      const flip = isHovered && s.x + half + gap + widest + pad > w;
      // A sunflower's name sits over its head, centred, in the open sky:
      // beside the flower it ran across the next one's petals. In the
      // simplified map every title does — beside a node on a ring, it lay
      // across the spokes and the next idea round.
      const above =
        styleRef.current === "simplified" ||
        (styleRef.current === "sunflower" && isConversation && placed.flowers.has(n));
      const textX = above
        ? s.x - widest / 2
        : flip
          ? s.x - half - gap - widest
          : s.x + half + gap;
      const anchorY = tree ? s.y + tree.height * 0.5 : s.y;
      // A card that would hang off the top or the bottom is pushed back
      // inside. Eight lines of claim is tall enough for this to matter, and a
      // bubble cut off by the edge of the map is the same failure as one cut
      // off by its own width.
      const blockH = lines.length * lineHeight;
      const textY = above
        ? s.y - half - gap - blockH
        : isHovered
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
      laid.push({ n, lines, x: textX, y: textY, lineHeight, isConversation, box, px });
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
      ctx.font = labelFont(l.px, l.isConversation);
      ctx.globalAlpha = inFocus(l.n) ? 1 : 0.2;

      // What is being pointed at gets a bubble under it. On a dense map a
      // label lands on top of links and other labels and becomes unreadable
      // exactly when it is being read — this puts a card behind the one that
      // matters, so it is legible whatever it is over.
      if (hover === l.n) {
        // Generous relative to the text, not a hairline around it: the card
        // exists to lift the words off a busy map, and a tight one reads as a
        // box drawn on the label rather than as something behind it.
        const pad = Math.max(4, l.px * 0.85);
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
      // On the night sky the usual label colours are the app's ink — dark on
      // dark once the background has gone black. Stars are written in one
      // warm white, and so are their names.
      ctx.fillStyle = nightSky
        ? hover === l.n || isTraced(l.n)
          ? "#f3efe4"
          : "#d8d3c6"
        : hover === l.n || isTraced(l.n)
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
    // What is drawn reaches past the points nodes sit at — a tree's canopy,
    // the roots under it, a sunflower's stalk down to the grass — so the
    // arrangement's own extent is framed too.
    const e = placedRef.current.extent;
    if (e) {
      xs.push(e.x0, e.x1);
      ys.push(e.y0, e.y1);
    }
    // Room for a node's disc and a title beside it. The disc is in world
    // units and the title in screen pixels, so the title's share depends on
    // the scale being chosen: three passes land it.
    const maxR = Math.max(...nodes.map((n) => n.r)) * ruleset(w, styleRef.current).nodeScale;
    let pad = maxR + 34;
    let scale = 1;
    for (let i = 0; i < 3; i++) {
      const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs) + pad * 2);
      const spanY = Math.max(1, Math.max(...ys) - Math.min(...ys) + pad * 2);
      scale = Math.min((w * 0.94) / spanX, (h * 0.94) / spanY, 3.2);
      pad = maxR + 34 / scale;
    }
    const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
    const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
    viewRef.current = { x: -midX * scale, y: -midY * scale, scale };
  }, []);

  const build = useCallback(async () => {
    const data = await loadGraph(folder);
    setEmpty(data.nodes.length === 0);

    const colors = categoryColors(data.nodes.map((n) => n.category));
    setLegend([...colors.entries()]);

    const C = paletteRef.current;
    // The galaxy draws its people bigger than the other arrangements: a star
    // is a landmark in a dark field, and a planet a few pixels across is a
    // dot, not a world. The other arrangements mark their nodes with shape
    // (a tree, a flower); here size is all a node has.
    const galaxy = styleRef.current === "galaxy";
    // Reuse positions of nodes that already exist, so re-extraction does not
    // throw the whole map in the air.
    const previous = new Map(nodesRef.current.map((n) => [n.data.id, n]));
    let nodes: Node[] = data.nodes.map((d) => {
      const old = previous.get(d.id);
      const isConversation = d.kind === "conversation";
      const isMoon = d.kind === "moon";
      return {
        data: d,
        // A moon is visibly smaller than the claim it hangs from. It is the
        // reply, not a second idea — drawn the same size it would read as one
        // more thing to be argued with rather than as the argument back.
        r: isConversation
          ? (CONVERSATION_RADIUS + Math.min(12, d.weight * 2)) * (galaxy ? 1.55 : 1)
          : isMoon
            ? MOON_RADIUS * (galaxy ? 1.5 : 1)
            : (IDEA_RADIUS + Math.min(8, (d.weight - 1) * 4)) * (galaxy ? 1.45 : 1),
        // Its planet's colour: an answer is about the same subject as the
        // claim it defends, and giving it one of its own would put a stray
        // colour in the key for something that is not a subject.
        color: isConversation ? C.conversation : colors.get(d.category) ?? UNCATEGORISED,
        labelHalf: estimateLabelHalfWidth(d.label, isConversation),
        x: old?.x ?? (Math.random() - 0.5) * 400,
        y: old?.y ?? (Math.random() - 0.5) * 400,
      };
    });

    let byId = new Map(nodes.map((n) => [n.data.id, n]));
    let links: Link[] = data.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        id: e.id,
        kind: e.kind,
        reasoning: e.reasoning,
      }));

    // A conversation that produced no ideas is a failed star in the galaxy —
    // and clutter in every other arrangement, where it has no tree, roots or
    // orbit to stand on. It is kept for the galaxy, and for the forest, where
    // it is a seed not yet grown; the rest drop it.
    if (styleRef.current !== "galaxy" && styleRef.current !== "forest") {
      const claimed = new Set<string>();
      for (const l of links) if (l.kind === "from") claimed.add((l.source as Node).data.id);
      const kept = nodes.filter((n) => n.data.kind !== "conversation" || claimed.has(n.data.id));
      if (kept.length !== nodes.length) {
        nodes = kept;
        byId = new Map(nodes.map((n) => [n.data.id, n]));
        links = links.filter(
          (l) => byId.has((l.source as Node).data.id) && byId.has((l.target as Node).data.id),
        );
      }
    }

    nodesRef.current = nodes;
    linksRef.current = links;
    // An arrangement with nothing left in it after the failed stars were
    // dropped is still nothing mapped, so the empty note has to reflect it.
    if (styleRef.current !== "galaxy") setEmpty(nodes.length === 0);

    // Which sunflower each idea petal belongs to, so petals point outward.
    const parent = new Map<Node, Node>();
    for (const l of links) {
      if (l.kind === "from") parent.set(l.target as Node, l.source as Node);
    }
    parentRef.current = parent;
    petalPopRef.current = new Map();

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
    ideaCountRef.current = orbitCount;

    simRef.current?.stop();

    // Forest and Galaxy are arrangements, not forces: where a node goes is
    // decided outright, so there is nothing for a simulation to settle. Pinned
    // rather than merely positioned, so dragging one puts it back rather than
    // leaving a tree with a branch wandering off.
    if (styleRef.current !== "nodes") {
      // A square spiral on a wide, short canvas is framed by its height, and
      // the fit zoom pays for it: every star shrinks until the map drops
      // under the zoom where anything is readable. So the galaxy's spiral is
      // flattened to the pane it will be framed in — a galaxy seen edge-on
      // rather than face-on, which is also what one does from the inside.
      // `||`, not `??`: a hidden map measures 0, not nothing, and planning
      // for a zero-wide pane stacked the simplified map into one column.
      const cw = canvasRef.current?.clientWidth || 900;
      const ch = canvasRef.current?.clientHeight || 600;
      const flat = Math.min(1, Math.max(0.42, (ch * 1.2) / Math.max(1, cw)));
      placedRef.current =
        styleRef.current === "forest"
          ? arrangeForest(nodes, links, spreadRef.current, secretTreesRef.current)
          : styleRef.current === "sunflower"
            ? arrangeSunflowers(nodes, links, spreadRef.current)
            : styleRef.current === "simplified"
              ? arrangeSimplified(nodes, links, spreadRef.current, cw / Math.max(1, ch))
              : arrangeGalaxy(nodes, links, spreadRef.current, flat);
      moonsRef.current = moonsOf(nodes, placedRef.current.outward);
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
            // The spacing setting widens and narrows the springs as well as
            // the push: without this it only moved the charge, and "roomy"
            // mostly fought the link springs instead of spreading the map.
            const spacing = SPREAD_INNER[spreadRef.current];
            // A moon is already pinned beside its planet every frame, so this
            // spring can only pull on the *planet*. At the "related" distance
            // it would shove the claim 280 units away from its own answer.
            if (l.kind === "answers") return MOON_ORBIT;
            if (l.kind !== "from") return rules.related * spacing;
            const n = orbitCount.get((l.source as Node).data.id) ?? 1;
            return (
              rules.orbit * spacing + Math.max(0, n - 4) * rules.orbitGrowth * spacing
            );
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
          return rules.charge - n.r * rules.chargeByRadius;
        }),
      )
      // Conversations with their ideas, kept apart as wholes: this is what
      // the spacing setting moves in this layout. See `forceClusters`.
      .force(
        "clusters",
        forceClusters(clusterGroups(links), () => 80 * SPREAD_GAP[spreadRef.current]),
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
          // only pushes everything apart for nothing. The spacing setting
          // scales the breathing room too, or "close" cannot close a map in.
          const spacing = SPREAD_INNER[spreadRef.current];
          return n.r + rules.padding * spacing + n.labelHalf * rules.labelShare;
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
      .force("x", forceX(0).strength(0.035))
      .force("y", forceY(0).strength(0.035))
      .alphaDecay(0.02)
      // Never freezes completely: a nudge keeps it alive enough to respond to a
      // drag without needing to be woken up.
      .alphaMin(0.001)
      .velocityDecay(0.35);

    simRef.current = sim;
    sim.alpha(1).restart();

    // Let it find most of its shape before framing, or the first fit
    // captures the initial scatter. Only most: ticking all the way to rest in
    // one go froze the app for seconds on a large map, every time the style
    // changed or the map came back on screen.
    settleFor(sim, 60);
    // Before the frame is measured, or a moon the simulation flung somewhere
    // is part of what the map is framed around.
    settleMoons(moonsRef.current);
    fitToView();
    // What the budget left unsettled finishes live. Frame it again when it
    // comes to rest — unless the view has been moved in the meantime.
    const framed = { ...viewRef.current };
    sim.on("end", () => {
      const v = viewRef.current;
      if (v.x === framed.x && v.y === framed.y && v.scale === framed.scale) fitToView();
    });
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
      // Nothing is drawn while the map is off screen — another tab, a hidden
      // panel, a minimised window. A zero-sized canvas still ran the whole
      // frame, and the rest of the app paid for it.
      const c = canvasRef.current;
      if (c && c.clientWidth > 0 && !document.hidden) draw();
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
              // A moon holds station on its planet — the exemption the first
              // seed gives it has to survive a resize too, or moons start
              // reserving label space and the map re-spreads around nothing.
              if (n.data.kind === "moon") return n.r + 2;
              const spacing = SPREAD_INNER[spreadRef.current];
              return n.r + rules.padding * spacing + n.labelHalf * rules.labelShare;
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
          settleFor(sim, 60);
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
    const k = viewRef.current.scale;
    const spec = styleRef.current === "forest" ? placedRef.current.trees.get(n) : undefined;
    // A tree is pointed at as a tree: its notes ring its middle, and no disc
    // is laid over it. The same for everything drawn as a shape of its own —
    // a root, a petal, a flower head — where a disc hid the very thing lit.
    const y = spec ? s.y + spec.height * k * 0.5 : s.y;
    return {
      x: s.x,
      y,
      r: spec
        ? spec.height * k * 0.5
        : drawnRadius(n.r, k, canvas.clientWidth, styleRef.current),
      color: n.color,
      below: y > canvas.clientHeight / 2,
      disc: styleRef.current !== "forest" && styleRef.current !== "sunflower",
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
   * position on the map, so the centre of the frame is what stays put.
   */
  function zoomBy(factor: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    cancelTravel();
    const v = viewRef.current;
    const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.scale * factor));
    if (scale === v.scale) return;
    const k = scale / v.scale;
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
    releasePin(hoverRef.current);
    hoverRef.current = null;
    keepAliveRef.current = null;
    setHovered(null);
    setHoverAt(null);
  }

  /**
   * Release a node that was held still because it was being pointed at.
   *
   * A node being dragged keeps its drag pin, and one being flown to keeps its
   * travel pin — releasing those here would be the same bug wearing gloves.
   */
  function releasePin(n: Node | null) {
    if (!n || dragNodeRef.current === n || travelRef.current?.node === n) return;
    n.fx = null;
    n.fy = null;
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

  /** The pointer's shape: a hand over bare map, a pointer over anything live.
   *  Set in JS because the whole map is one canvas — there is no element for a
   *  CSS `cursor: pointer` to hang off. */
  function setCursor(cursor: string) {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = cursor;
  }

  /**
   * Whether relation lines answer to the pointer at this zoom.
   *
   * The gate exists because a line pulled back far enough is a pixel among
   * pixels and its popup a fifth of the screen. A galaxy's lines are the
   * exception: they run long and clear across the dark, and the fit zoom of
   * even a modest galaxy sits under the readable gate — gated the same way,
   * the contradictions could never be pointed at, let alone settled.
   */
  function edgesReadable(): boolean {
    // Always. A contradiction is the one thing on the map asking a question,
    // and gating it by zoom left the red lines of a framed map unclickable —
    // the hit tolerance is in screen pixels, so it is as easy to hit far out.
    return true;
  }

  /**
   * The sunflower whose stem or head is under the pointer — what a flower is
   * picked up by. Its petals are ideas, and pressing one is for opening it.
   */
  function flowerAt(clientX: number, clientY: number): Node | null {
    if (styleRef.current !== "sunflower") return null;
    const world = toWorld(clientX, clientY);
    const k = viewRef.current.scale;
    for (const [hub, f] of placedRef.current.flowers) {
      const hx = hub.x ?? 0;
      const hy = hub.y ?? 0;
      const onStem = Math.abs(world.x - hx) <= Math.max(6, 7 / k) && world.y >= hy && world.y <= 0;
      if (onStem || Math.hypot(world.x - hx, world.y - hy) <= f.disc) return hub;
    }
    return null;
  }

  /** Stand a sunflower at `x`, petals and all. It stays planted: it moves
   *  along the ground, and its stalk still reaches the grass. */
  function moveFlower(hub: Node, x: number) {
    const dx = x - (hub.x ?? 0);
    if (!dx) return;
    hub.x = x;
    hub.fx = x;
    for (const [n, p] of placedRef.current.petals) {
      if (p.hub !== hub) continue;
      n.x = (n.x ?? 0) + dx;
      n.fx = n.x;
    }
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
    const style = styleRef.current;
    const placed = placedRef.current;
    const k = viewRef.current.scale;
    const world = toWorld(clientX, clientY);

    // A petal is an ellipse along its ray, and is tested as one — the front
    // ring before the ones behind it, the order they are drawn in.
    if (style === "sunflower") {
      let petal: Node | null = null;
      let ring = Infinity;
      for (const [n, p] of placed.petals) {
        const dx = world.x - (p.hub.x ?? 0);
        const dy = world.y - (p.hub.y ?? 0);
        const cos = Math.cos(p.angle);
        const sin = Math.sin(p.angle);
        const along = (dx * cos + dy * sin - (p.inner + p.len / 2)) / (p.len / 2);
        const across = (dy * cos - dx * sin) / p.halfW;
        if (along * along + across * across <= 1 && p.ring < ring) {
          petal = n;
          ring = p.ring;
        }
      }
      if (petal) return petal;
      for (const [hub, f] of placed.flowers) {
        if (Math.hypot(world.x - (hub.x ?? 0), world.y - (hub.y ?? 0)) <= f.disc) return hub;
      }
    }


    let best: Node | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      // The meadow's flowers and petals answered above, as the shapes they
      // are; only what stands loose is left to find by distance.
      if (style === "sunflower" && (placed.petals.has(n) || placed.flowers.has(n))) continue;
      const s = toScreen(n, w, h);

      // A conversation in a forest is a tree, so the tree is what answers to
      // the pointer. Testing a circle at the apex meant the whole canopy —
      // the part that actually looks like the thing — was dead, and the only
      // live spot was a patch of sky above it.
      if (style === "forest" && n.data.kind === "conversation") {
        const spec = placed.trees.get(n);
        if (spec && onTree(spec, n.x ?? 0, world.x, world.y)) {
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
    // A root answers along its whole length, not only at the tip. The root
    // *is* the idea, so the whole run from its fork to where it ends is the
    // idea's own clickable body.
    if (style === "forest") {
      for (const root of placed.roots) {
        const d = polylineDistance(taperPoints(root), world.x, world.y) * k;
        if (d <= Math.max(9, root.w0 * k) && d < bestDist) {
          best = root.idea;
          bestDist = d;
        }
      }
    }
    return best;
  }

  /**
 * How far a path between two nodes has to bend so it does not run through a
 * third thing.
 *
 * A connection between two ideas should not cross a third: a pollen stream
 * that sails through a neighbour's flower, or a wire that slices another
 * tree's roots, reads as belonging to the thing it crosses. Every node near
 * the straight chord between the endpoints pushes the path away by however
 * deeply it intrudes, so an arch deepens around what stands in its way —
 * measured in screen pixels, since what counts as "through" is drawn size.
 */
function chordClearance(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  skip: Set<string>,
  w: number,
  h: number,
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  if (len2 < 1) return 0;
  let clear = 0;
  const scale = viewRef.current.scale;
  for (const n of nodesRef.current) {
    if (skip.has(n.data.id)) continue;
    const s = toScreen(n, w, h);
    const t = ((s.x - ax) * vx + (s.y - ay) * vy) / len2;
    // The path only leaves its chord in the middle of the run; an obstacle
    // sitting on an endpoint is stood beside deliberately.
    if (t <= 0.02 || t >= 0.98) continue;
    const px = ax + vx * t;
    const py = ay + vy * t;
    const d = Math.hypot(s.x - px, s.y - py);
    const rr = drawnRadius(n.r, scale, w, styleRef.current) + 10;
    if (d < rr) clear = Math.max(clear, rr - d);
  }
  return clear;
}

/** The nearest correlation or contradiction line, if the click landed close
   *  enough to it — the only edges meant to be clickable. */
  function edgeAt(clientX: number, clientY: number): Link | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    let best: Link | null = null;
    // Generous enough to land on a dashed line by hand.
    let bestDist = 12;
    const style = styleRef.current;
    const placed = placedRef.current;
    for (const link of linksRef.current) {
      if (link.kind !== "related" && link.kind !== "contradicts") continue;
      const na = link.source as Node;
      const nb = link.target as Node;
      // The drawn line, not the straight chord: a forest relation runs its
      // lane underground and a meadow one arcs over the grass, so testing the
      // chord would put the popup nowhere near the line it describes.
      let pts: Pt[];
      if (style === "forest") {
        const route = placed.lanes.get(link);
        if (!route) continue;
        pts = route.map((p) => toScreen(p, w, h));
      } else {
        const a = toScreen(na, w, h);
        const b = toScreen(nb, w, h);
        if (style === "sunflower") {
          const straight = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const clear = chordClearance(a.x, a.y, b.x, b.y, new Set([na.data.id, nb.data.id]), w, h);
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2 + meadowArch(straight, clear);
          const steps = Math.min(160, Math.max(24, Math.ceil(straight / 4)));
          pts = [];
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            pts.push({ x: quad(a.x, midX, b.x, t), y: quad(a.y, midY, b.y, t) });
          }
        } else {
          pts = [a, b];
        }
      }
      const d = polylineDistance(pts, px, py);
      if (d < bestDist) {
        best = link;
        bestDist = d;
      }
    }
    return best;
  }

  /** Canvas coordinates to world coordinates: the exact inverse of `toScreen`. */
  function toWorld(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const v = viewRef.current;
    const k = v.scale;
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
        pointerRef.current = null;
        dragFlowerRef.current = null;
        if (dragNodeRef.current) {
          dragNodeRef.current.fx = null;
          dragNodeRef.current.fy = null;
          dragNodeRef.current = null;
        }
        releasePin(hoverRef.current);
        hoverRef.current = null;
        keepAliveRef.current = null;
        setHovered(null);
        setHoverAt(null);
        edgeHoverRef.current = null;
        setEdgeHover(null);
        setCursor("");
      }}
    >
      <canvas
        ref={canvasRef}
        className="graph"
        onMouseDown={(e) => {
          // The right button belongs to the context menu. Letting it through
          // here made a right-press pin a node and its release run the click
          // path — so opening the menu also flew the map into the idea and
          // opened its file underneath the menu.
          if (e.button !== 0) return;
          // Any deliberate move of the view takes it over from the animation.
          cancelTravel();
          setCursor("grabbing");
          // A sunflower is picked up by its stem or its head and carried along
          // the ground. Its petals are ideas — pressing one is for opening it
          // — so nothing else in the meadow is dragged.
          if (styleRef.current === "sunflower") {
            const flower = lockRef.current ? null : flowerAt(e.clientX, e.clientY);
            if (flower) {
              dragFlowerRef.current = {
                hub: flower,
                dx: toWorld(e.clientX, e.clientY).x - (flower.x ?? 0),
              };
              dropHover();
            }
            panRef.current = { x: e.clientX, y: e.clientY, moved: false };
            return;
          }
          // With the nodes locked, pressing one is never the start of a drag
          // — the arrangements are compositions, and this is how they stay
          // as drawn. Panning still works, and so does clicking through. Far
          // enough out the same zoom gate applies as to clicks: grabbing a dot
          // nobody can name is dragging by guesswork.
          const hit =
            !lockRef.current && viewRef.current.scale >= READABLE_ZOOM
              ? nodeAt(e.clientX, e.clientY)
              : null;
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
          // Remembered for the draw loop: the galaxy turns without pointer
          // movement, and its edge hover is re-tested against this between
          // moves.
          const rectNow = canvasRef.current?.getBoundingClientRect();
          pointerRef.current = rectNow
            ? { x: e.clientX - rectNow.left, y: e.clientY - rectNow.top }
            : null;
          const carried = dragFlowerRef.current;
          if (carried) {
            setCursor("grabbing");
            moveFlower(carried.hub, toWorld(e.clientX, e.clientY).x - carried.dx);
            const pan = panRef.current;
            if (pan && Math.abs(e.clientX - pan.x) + Math.abs(e.clientY - pan.y) > 2) {
              pan.moved = true;
            }
            return;
          }
          const drag = dragNodeRef.current;
          if (drag) {
            setCursor("grabbing");
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
            setCursor("grabbing");
            const dx = e.clientX - pan.x;
            const dy = e.clientY - pan.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
            viewRef.current.x += dx;
            viewRef.current.y += dy;
            pan.x = e.clientX;
            pan.y = e.clientY;
            // A pan moves every node out from under the pointer. The hover
            // overlay is anchored to where its node stood when you pointed at
            // it, so carrying it through the pan hangs a card in empty space
            // at the old position — dropped here, re-tested once the view is
            // still again.
            if (hoverRef.current) dropHover();
            return;
          }
          // Pointing works at every zoom. It used to stop below the zoom where
          // a label could be read, which made the far half of the map feel
          // dead — and the failure it guarded against is answered in the render
          // below: pulled back far enough, pointing at a speck draws only the
          // node's own ring and name, not the card that dims the whole map.
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
            // Whatever was held still for being pointed at goes back into the
            // movement of the map, and the one being pointed at now holds
            // still for as long as it is being read.
            releasePin(hoverRef.current);
            hoverRef.current = hit;
            if (hit && !dragNodeRef.current) {
              hit.fx = hit.x ?? 0;
              hit.fy = hit.y ?? 0;
            }
            setHovered(hit?.data ?? null);
            const at = hit ? screenPos(hit) : null;
            setHoverAt(at);
            // The ring, plus the radius of a note circle, plus room to travel.
            keepAliveRef.current = at ? { x: at.x, y: at.y, r: at.r + 62 + 52 } : null;
          }

          // A correlation or contradiction line names how two ideas connect —
          // worth reading on the way past, not worth a click to find out.
          if (hit) {
            setCursor("pointer");
            if (edgeHoverRef.current) {
              edgeHoverRef.current = null;
              setEdgeHover(null);
            }
            return;
          }
          // A stem says it can be picked up.
          if (!lockRef.current && flowerAt(e.clientX, e.clientY)) {
            setCursor("grab");
            return;
          }
          // The lines keep their gate, though the nodes lost theirs: a relation line
          // at that zoom is a pixel among pixels and its popup is a fifth of
          // the screen, so it is a large explanation of a line nobody can
          // point at on purpose.
          const edge = edgesReadable() ? edgeAt(e.clientX, e.clientY) : null;
          if (edge) {
            const rect = canvasRef.current?.getBoundingClientRect();
            const next = {
              kind: edge.kind as "related" | "contradicts",
              a: (edge.source as Node).data,
              b: (edge.target as Node).data,
              reasoning: edge.reasoning,
              x: rect ? e.clientX - rect.left : 0,
              y: rect ? e.clientY - rect.top : 0,
            };
            edgeHoverRef.current = next;
            setEdgeHover(next);
            setCursor("pointer");
          } else {
            setCursor("");
            if (edgeHoverRef.current) {
              edgeHoverRef.current = null;
              setEdgeHover(null);
            }
          }
        }}
        onMouseUp={(e) => {
          // A release of any other button is not a click: the press was never
          // allowed to start a drag or a pan, and it must not finish one.
          if (e.button !== 0) return;
          const wasDrag = panRef.current?.moved ?? false;
          setCursor("");
          if (dragNodeRef.current) {
            // Released back into the simulation rather than left pinned, so the
            // map keeps behaving like one thing.
            dragNodeRef.current.fx = null;
            dragNodeRef.current.fy = null;
            dragNodeRef.current = null;
            simRef.current?.alphaTarget(0);
          }
          dragFlowerRef.current = null;
          panRef.current = null;
          if (wasDrag) return;

          // A click is a decision, and decisions are made about things you can see.
          // Pulled back far enough, nodes are dots a few pixels apart and
          // picking one is a guess at best — so past the zoom where anything
          // is legible, a click answers nothing and is spent on the bare map
          // instead (which puts the titles away). Hovering answers at every
          // zoom: that is a side effect of where the pointer rests.
          const readable = viewRef.current.scale >= READABLE_ZOOM;
          const hit = readable ? nodeAt(e.clientX, e.clientY) : null;
          if (!hit) {
          // A contradiction is the one edge worth clicking: it is the only
          // thing on the map that asks the person a question. Checked before
          // the map is cleared, or the click would only ever dismiss labels.
          const edge = edgesReadable() ? edgeAt(e.clientX, e.clientY) : null;
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
          // The map's own menu, not the browser's. A node answers here on the
          // same terms as a click — past the zoom where anything is legible,
          // naming a node would be naming a guess.
          e.preventDefault();
          const hit =
            viewRef.current.scale >= READABLE_ZOOM ? nodeAt(e.clientX, e.clientY) : null;
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
          // Whatever is under the cursor stays under it.
          const k = scale / v.scale;
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
              <p className="graph-arrange-head">Spacing</p>
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
              <p className="graph-arrange-head">Moving the nodes</p>
              <div className="graph-arrange-row">
                <button
                  type="button"
                  className={!locked ? "on" : undefined}
                  title="Push nodes around; a force layout reorganises around the one you hold"
                  onClick={() => {
                    void getSettings().then((st) => saveSettings({ ...st, map_lock_nodes: false }));
                  }}
                >
                  Free
                </button>
                <button
                  type="button"
                  className={locked ? "on" : undefined}
                  title="Nothing can be dragged out of place — the arrangement stays exactly as drawn"
                  onClick={() => {
                    void getSettings().then((st) => saveSettings({ ...st, map_lock_nodes: true }));
                  }}
                >
                  Locked
                </button>
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

      {hovered &&
        hoverAt &&
        // Pulled back far enough, pointing at a speck draws only the ring and
        // the name on the canvas — the dimming card over a dot nobody can read
        // the nudges of is the wash that made pointing stop below this zoom
        // once before.
        viewRef.current.scale >= READABLE_ZOOM && <Nudges node={hovered} at={hoverAt} />}

      {/* The hovered node's name is drawn on the canvas beside it — the card
          that used to pin itself to a corner of the screen said the same
          thing twice, and stayed long after the pointer had moved on. */}

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
            <div className="relation-do">Click to resolve it</div>
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
              onOpenConversation={(id, ideaId) => openConversation.current(id, ideaId)}
              onClose={() => setPanel(null)}
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
}: {
  node: GraphNode;
  at: { x: number; y: number; r: number; color: string; below: boolean; disc: boolean };
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
      {at.disc && (
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
      )}
      {points.map((p, i) => {
        const angle = (i / points.length) * Math.PI * 2 - Math.PI / 2;
        const style = {
          left: at.x,
          top: at.y,
          "--dx": `${Math.cos(angle) * radius}px`,
          "--dy": `${Math.sin(angle) * radius}px`,
          animationDelay: `${i * 45}ms`,
        } as React.CSSProperties;
        return (
          <span key={i} className={`ai-nudge ${p.kind}${at.below ? " up" : ""}`} style={style}>
            AI
            <span className="ai-text">{p.text}</span>
          </span>
        );
      })}
    </div>
  );
}
