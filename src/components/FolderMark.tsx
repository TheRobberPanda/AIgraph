import { folderColor, ROOT_FOLDER } from "../lib/folders";

/**
 * The glyph that stands for a folder.
 *
 * Root is the tree — everything unsorted grows on it. Every other folder is a
 * branch off it, turned one of four ways so two folders side by side are told
 * apart by shape as well as by colour. One well-drawn branch rotated beats four
 * separately drawn ones: at fifteen pixels, fiddly variation reads as noise.
 * Both the turn and the colour come from the name, so a folder looks the same
 * everywhere without storing anything extra.
 */
function hash(name: string): number {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export default function FolderMark({
  name,
  id,
  size = 16,
}: {
  name: string;
  /** Root is the tree; anything else is a branch off it. */
  id?: number;
  size?: number;
}) {
  const color = folderColor(name);
  const turn = (hash(name) % 4) * 90;
  return (
    <svg
      className="folder-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {id === ROOT_FOLDER ? (
        <>
          {/* Trunk and a two-tier crown — unmistakably a tree even small. */}
          <path d="M8 15 L8 11" />
          <path d="M8 1.5 L12 7 L4 7 Z" fill={color} fillOpacity="0.18" />
          <path d="M8 5 L13.5 11.5 L2.5 11.5 Z" fill={color} fillOpacity="0.18" />
        </>
      ) : (
        <g transform={`rotate(${turn} 8 8)`}>
          {/* Shoots leave the stem angled the way it is already going, the
              way a real branch forks. Twigs drawn back against the stem read
              as a scribble rather than as a branch. */}
          <path d="M2.8 13.6 L13.2 3.2" />
          <path d="M6.6 9.8 L5.4 4.8" />
          <path d="M9.6 6.8 L14.2 7.6" />
        </g>
      )}
    </svg>
  );
}
