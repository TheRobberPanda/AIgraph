import Sheet from "./Sheet";

const KEY = "aigraph-onboarded";

/** Whether the welcome has been seen on this machine. */
export function onboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage that throws is not a reason to greet someone on every start.
    return true;
  }
}

function markOnboarded() {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* nothing to remember it in */
  }
}

/**
 * The first thing on a first open: nothing works until a model is chosen, so
 * the app asks for one before anything else, and says which to pick.
 */
export default function Onboarding({
  onChoose,
  onClose,
}: {
  /** Open the model picker on this tab. */
  onChoose: (source: "local" | "cloud") => void;
  onClose: () => void;
}) {
  const choose = (source: "local" | "cloud") => {
    markOnboarded();
    onChoose(source);
  };
  const close = () => {
    markOnboarded();
    onClose();
  };

  return (
    <Sheet size="mid" onClose={close}>
      <div className="sheet-head">
        <h2 className="sheet-title">Choose a model to think with</h2>
      </div>
      <div className="sheet-body onboarding">
        <p className="blurb">
          Everything here — the replies, the ideas pulled out of your conversations, the map —
          is written by a language model. Pick one to start. You can change it any time from the
          model name at the top of the window.
        </p>

        <button className="onboarding-choice best" onClick={() => choose("cloud")}>
          <span className="onboarding-choice-head">
            Cloud, through OpenRouter <span className="tag ready">easiest</span>
          </span>
          <span className="onboarding-choice-body">
            Make a key at openrouter.ai, paste it in, and press <b>Free</b> to list the models that
            cost nothing. Works on any computer and answers fast. Your conversations are sent to
            the model's provider.
          </span>
        </button>

        <button className="onboarding-choice" onClick={() => choose("local")}>
          <span className="onboarding-choice-head">
            Local, on this computer <span className="tag">private</span>
          </span>
          <span className="onboarding-choice-body">
            Download a model once and nothing you say ever leaves this machine. Slower, and it
            wants a few gigabytes of disk and memory — but if your computer can manage it, this
            is the way we'd encourage: your thinking stays yours.
          </span>
        </button>

        <p className="blurb warn">
          Skip models marked with a yellow <b>!</b> — they can't stop reasoning before they answer,
          and that makes every reply and every read painfully slow.
        </p>

        <div className="row">
          <button className="btn subtle" onClick={close}>
            Later
          </button>
        </div>
      </div>
    </Sheet>
  );
}
