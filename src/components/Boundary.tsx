import { Component, type ReactNode } from "react";

/**
 * Keeps one broken panel from taking the window with it.
 *
 * React unmounts the whole tree when a render throws, and with nothing to
 * catch it the app goes black — which is what "it crashed" looks like from
 * the outside, whatever actually went wrong. In a thinking tool that is worse
 * than it sounds: the composer goes too, and with it whatever was half
 * written.
 *
 * So each panel gets one of these. The rest of the app stays up, the thing
 * that failed says what it was, and there is a way back that does not involve
 * restarting.
 */
export default class Boundary extends Component<
  { children: ReactNode; what: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // The message on screen is deliberately short; the console gets the stack,
    // which is the part worth having when someone reports this.
    console.error("panel failed:", this.props.what, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pane-inner">
        <p className="error">
          <strong>{this.props.what} could not be drawn.</strong>
        </p>
        <p className="blurb">
          The rest of the app is still running — whatever you were writing is
          where you left it. The full error is in the developer console.
        </p>
        <p className="path">{error.message}</p>
        <div className="row">
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
