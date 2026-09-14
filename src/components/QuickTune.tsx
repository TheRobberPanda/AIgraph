import { useEffect, useState } from "react";
import { getSettings, saveSettings, type AnswerStyle, type Settings } from "../lib/settings";

/**
 * One question about how the AI is behaving, under the call toggle.
 *
 * Only on every second new chat, and only about settings that change what the
 * model does — how it responds, whether it thinks first, whether it recalls,
 * how it answers. Settings are somewhere people go when something is already
 * wrong; this asks at the moment it is easiest to change, before the
 * conversation starts, and then gets out of the way.
 */

interface Question {
  id: string;
  ask: string;
  answer: string;
  applies: (s: Settings) => boolean;
  patch: (s: Settings) => Partial<Settings>;
}

const withStyle = (s: Settings, style: AnswerStyle): Partial<Settings> => ({
  answer_styles: [...(s.answer_styles ?? []).filter((x) => x !== style), style],
});
const has = (s: Settings, style: AnswerStyle) => (s.answer_styles ?? []).includes(style);

const QUESTIONS: Question[] = [
  {
    id: "agreeable",
    ask: "Is the AI being too agreeable?",
    answer: "Have it push back",
    applies: (s) => s.chat_stance !== "challenge",
    patch: () => ({ chat_stance: "challenge" }),
  },
  {
    id: "argues",
    ask: "Is the AI arguing with you too much?",
    answer: "Just help lay it out",
    applies: (s) => s.chat_stance === "challenge",
    patch: () => ({ chat_stance: "organize" }),
  },
  {
    id: "slow",
    ask: "Are answers slow to start?",
    answer: "Stop it thinking first",
    applies: (s) => s.reasoning,
    patch: () => ({ reasoning: false }),
  },
  {
    id: "shallow",
    ask: "Are answers too shallow?",
    answer: "Let it think first",
    applies: (s) => !s.reasoning,
    patch: () => ({ reasoning: true }),
  },
  {
    id: "long",
    ask: "Are replies too long?",
    answer: "Keep them brief",
    applies: (s) => !has(s, "brief"),
    patch: (s) => withStyle(s, "brief"),
  },
  {
    id: "abstract",
    ask: "Is the AI too abstract?",
    answer: "Ask for examples",
    applies: (s) => !has(s, "examples"),
    patch: (s) => withStyle(s, "examples"),
  },
  {
    id: "jargon",
    ask: "Too much jargon?",
    answer: "Use plain words",
    applies: (s) => !has(s, "plain"),
    patch: (s) => withStyle(s, "plain"),
  },
  {
    id: "recall",
    ask: "Should it connect this to what you said before?",
    answer: "Turn on recall",
    applies: (s) => !s.recall,
    patch: () => ({ recall: true }),
  },
];

const COUNT_KEY = "quick-tune-chats";
/** Counted once per new chat, however many times React mounts the prompt. */
let countedAt = 0;

/**
 * Advance the count of new chats, and return it. Called by the app when one
 * actually starts — at launch, and whenever a conversation is filed — not when
 * the empty chat is merely shown again after visiting another tab.
 */
export function nextChatNumber(): number {
  try {
    const n = Number(localStorage.getItem(COUNT_KEY) ?? "0") || 0;
    // StrictMode mounts twice in development; a new chat is not two chats.
    if (Date.now() - countedAt < 1500) return n;
    countedAt = Date.now();
    localStorage.setItem(COUNT_KEY, String(n + 1));
    return n + 1;
  } catch {
    return 1;
  }
}

export default function QuickTune({ chat }: { chat: number }) {
  const [s, setS] = useState<Settings | null>(null);
  const [state, setState] = useState<"asking" | "done" | "gone">("asking");

  useEffect(() => {
    if (chat % 2 !== 0) return;
    void getSettings()
      .then(setS)
      .catch(() => {});
  }, [chat]);

  if (chat % 2 !== 0 || !s || !s.quick_tune || state === "gone") return null;

  const open = QUESTIONS.filter((q) => q.applies(s));
  if (open.length === 0) return null;
  // A different question each time it is shown, rather than the same one.
  const q = open[Math.floor(chat / 2) % open.length];

  if (state === "done") {
    return (
      <div className="quick-tune">
        <span className="quick-tune-done">Changed — it's under Settings › Conversation too.</span>
      </div>
    );
  }

  return (
    <div className="quick-tune">
      <span className="quick-tune-ask">{q.ask}</span>
      {/* Plain, not `on`: the tint is what a setting already switched on looks
          like, and this is only offering to switch it. */}
      <button
        className="btn"
        onClick={() => {
          const next = { ...s, ...q.patch(s) };
          void saveSettings(next)
            .then(() => setState("done"))
            .catch(() => setState("gone"));
        }}
      >
        {q.answer}
      </button>
      <button className="btn" onClick={() => setState("gone")}>
        It's fine
      </button>
      {/* Off for good, not just for this chat. Settings › Conversation is
          where it comes back, which the tooltip says so it isn't a trapdoor. */}
      <button
        type="button"
        className="quick-tune-switch"
        role="switch"
        aria-checked={true}
        data-tip="Stop suggesting these — turn them back on in Settings › Conversation"
        onClick={() => {
          void saveSettings({ ...s, quick_tune: false })
            .then(() => setState("gone"))
            .catch(() => setState("gone"));
        }}
      >
        <span className="quick-tune-track" aria-hidden="true">
          <span className="quick-tune-knob" />
        </span>
        Suggestions
      </button>
    </div>
  );
}
