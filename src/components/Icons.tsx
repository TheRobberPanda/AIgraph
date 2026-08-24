/**
 * A small set of hand-drawn line icons for navigation.
 *
 * Inline SVG rather than an icon font or library — six icons don't justify a
 * dependency, and stroke="currentColor" means every icon follows the same
 * hover/active color rules as its label with no extra CSS.
 */
import type { SVGProps } from "react";

function Base(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

/** A speech bubble — the Think tab. */
export function IconThink(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 5h16v11H8l-4 4V5z" />
    </Base>
  );
}

/** Three linked nodes — the Map. */
export function IconMap(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M8 8l6.5 8.5M16 8l-6.5 8.5" />
    </Base>
  );
}

/** A single lit bulb — Ideas. */
export function IconIdeas(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.4.3.5.6.5 1.1v.5h6v-.5c0-.5.1-.8.5-1.1A6 6 0 0 0 12 3z" />
    </Base>
  );
}

/** A stack of turns — Conversations. */
export function IconChats(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <path d="M4 5h13v7H9l-4 3.5V5z" />
      <path d="M9 15h11v6l-3-2H9z" opacity="0.55" />
    </Base>
  );
}

/** A small chip — Models. */
export function IconModels(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </Base>
  );
}

/** A cog — Settings. */
export function IconSettings(props: SVGProps<SVGSVGElement>) {
  return (
    <Base {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Base>
  );
}

/** One pane — the simple layout. */
export function IconOnePane(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
    </Base>
  );
}

/** Panes either side of a middle — the layout with everything at once. */
export function IconPanes(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <path d="M9 5v14M15 5v14" />
    </Base>
  );
}

/** A paper plane — send. */
export function IconSend(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <path d="M21 3L11 13M21 3l-7 18-4-8-8-4z" />
    </Base>
  );
}

/** A back caret — used above deep-dive files. */
export function IconBack(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <path d="M15 5l-7 7 7 7" />
    </Base>
  );
}

/** A trash can — deleting one message. */
export function IconTrash(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </Base>
  );
}

/** A counter-clockwise arrow — rewinding the conversation to before a turn. */
export function IconRewind(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <path d="M4 9a8 8 0 1 1 1.5 8.5" />
      <path d="M4 4v5h5" />
    </Base>
  );
}

/** The window's own chrome, since the OS titlebar is gone. */
export function IconMinimize(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="12" height="12" {...props}>
      <path d="M4 12h16" />
    </Base>
  );
}

export function IconMaximize(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="12" height="12" {...props}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
    </Base>
  );
}

export function IconClose(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="12" height="12" {...props}>
      <path d="M5 5l14 14M19 5L5 19" />
    </Base>
  );
}

/** A plus — adding a conversation from outside the app. */
export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <path d="M12 5v14M5 12h14" />
    </Base>
  );
}

/** A box with a lid — the archive. */
export function IconArchive(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="15" height="15" {...props}>
      <path d="M3 7h18v3H3zM5 10v9h14v-9M10 14h4" />
    </Base>
  );
}

/** A folder — where a stretch of thinking gets filed. */
export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <path d="M3 6h6l2 2h10v11H3z" />
    </Base>
  );
}

/** A handset — call mode, where replies are short and spoken. */
export function IconCall(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <path d="M7 3H4a1 1 0 0 0-1 1c0 9.4 7.6 17 17 17a1 1 0 0 0 1-1v-3l-4-2-2 2a15 15 0 0 1-6-6l2-2z" />
    </Base>
  );
}

/** A speaker — replies read out loud. */
export function IconSpeaker(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M17 9a4 4 0 0 1 0 6" />
    </Base>
  );
}

/** A clock — how long a session may sit quiet before it is filed. */
export function IconClock(props: SVGProps<SVGSVGElement>) {
  return (
    <Base width="14" height="14" {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </Base>
  );
}

export function IconDownload(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"
         strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M8 2v8" />
      <path d="M4.5 7.5 8 11l3.5-3.5" />
      <path d="M2.5 13.5h11" />
    </svg>
  );
}

export function IconStop(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export function IconPlay(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...props}>
      <path d="M5 3.6v8.8a.6.6 0 0 0 .92.5l6.5-4.4a.6.6 0 0 0 0-1L5.92 3.1A.6.6 0 0 0 5 3.6Z" />
    </svg>
  );
}
