import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { RenderErrorBoundary } from './RenderErrorBoundary'

function ThrowsOnRender({ message }: { message: string }): never {
  throw new Error(message)
}

function ThrowsInEffect({ message }: { message: string }) {
  useEffect(() => {
    throw new Error(message)
  }, [message])
  return <div>never seen</div>
}

describe('RenderErrorBoundary', () => {
  beforeEach(() => {
    // React logs the caught error itself, and the boundary logs a second time.
    // Neither is a failure; silence them so a green run reads as green.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('keeps its siblings when a child throws while rendering', () => {
    render(
      <div>
        <p>the rest of the review</p>
        <RenderErrorBoundary label="The preview">
          <ThrowsOnRender message="boom" />
        </RenderErrorBoundary>
      </div>,
    )
    expect(screen.getByText('the rest of the review')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('The preview could not be rendered')
    expect(screen.getByRole('alert').textContent).toContain('boom')
  })

  // The one that matters for the SVG path: `buildSvgDom` runs in an effect, and
  // an unhandled throw there tears down the whole root exactly like a render
  // throw does.
  it('catches a throw from an effect', () => {
    render(
      <RenderErrorBoundary label="The preview">
        <ThrowsInEffect message="deep" />
      </RenderErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toContain('deep')
  })

  it('retries when the reset key changes, and not otherwise', () => {
    let shouldThrow = true
    function Maybe() {
      if (shouldThrow) throw new Error('still broken')
      return <div>fixed</div>
    }
    const { rerender } = render(
      <RenderErrorBoundary label="The preview" resetKey="v1">
        <Maybe />
      </RenderErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    // Same key: the fix on disk is invisible, because nothing says a rerender
    // is a new file.
    shouldThrow = false
    rerender(
      <RenderErrorBoundary label="The preview" resetKey="v1">
        <Maybe />
      </RenderErrorBoundary>,
    )
    expect(screen.queryByText('fixed')).toBeNull()

    rerender(
      <RenderErrorBoundary label="The preview" resetKey="v2">
        <Maybe />
      </RenderErrorBoundary>,
    )
    expect(screen.getByText('fixed')).toBeTruthy()
  })
})
