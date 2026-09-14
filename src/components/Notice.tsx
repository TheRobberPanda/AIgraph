import { useEffect, useState } from "react";
import { onNotice } from "../lib/notice";

/** The fading warning from `notify`. Gone once its animation ends. */
export default function Notice() {
  const [notice, setNotice] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => onNotice((text) => setNotice({ text, key: Date.now() })), []);

  if (!notice) return null;
  return (
    <div
      key={notice.key}
      className="notice-warn"
      role="status"
      onAnimationEnd={() => setNotice(null)}
    >
      {notice.text}
    </div>
  );
}
