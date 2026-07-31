import { Component, type ErrorInfo, type ReactNode } from 'react'

// A bulkhead. React unmounts the *entire* root when a render or an effect
// throws with no boundary above it, so one file the renderer chokes on takes
// the whole review with it — every other file, the comment rail, the toolbar,
// all replaced by a blank page with nothing on screen to say what happened or
// which file did it. That is the worst failure mode available here, because a
// reviewer's unsent drafts go with it and the obvious recovery (reload) walks
// straight back into the same file.
//
// Reviewed content is arbitrary by definition — it is whatever is on the
// branch — so "a renderer can throw on some file" is a standing condition, not
// a bug to be finished. Nothing here tries to guess *which* throws are
// plausible; it catches all of them and confines the damage to one pane.

interface Props {
  /** What failed to render, named in the fallback ("This SVG", "The review"). */
  label: string
  /**
   * A caught error is cleared when this changes, so a file edited into
   * something renderable renders again. Without it the pane stays broken for
   * the life of the session — React never retries a boundary on its own, and
   * the fix that would help has already landed on disk.
   */
  resetKey?: unknown
  children: ReactNode
}

interface State {
  error: Error | null
}

export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The fallback says what happened; the console is where the stack has to
    // go, since there is nowhere in the UI that a component stack belongs.
    console.error('krit: render failed, contained by a boundary', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="render-error" role="alert">
        <strong>{this.props.label} could not be rendered.</strong>{' '}
        {error.message || String(error)}
      </div>
    )
  }
}
