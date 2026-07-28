import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachEditors } from './CodeViewWrapper'

// A viewer whose render pass attaches editors, but where the first pass after
// entering edit mode is lost — Pierre's render queue swallows an exception
// raised earlier in the same pass, and there is no second attempt.
function viewer(passesLost: number) {
  const attached = new Set<string>()
  const wanted = new Set<string>()
  let lost = passesLost
  const instance = {
    render(immediate?: boolean) {
      if (immediate !== true) return
      if (lost > 0) {
        lost--
        return
      }
      for (const name of wanted) attached.add(name)
    },
  }
  return {
    attached,
    instance,
    want(name: string) {
      wanted.add(name)
    },
    getEditor: (name: string) => (attached.has(name) ? {} : undefined),
    getInstance: () => instance,
  } as never as Parameters<typeof attachEditors>[0] & {
    attached: Set<string>
    instance: typeof instance
    want(n: string): void
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('attachEditors', () => {
  it('forces a render when edit mode left a file without an editor', () => {
    // Without this, the file stays in edit mode with a live contenteditable and
    // no editor behind it: the header reads "Done" and keystrokes go nowhere,
    // with nothing to re-try since Pierre already sees the flag as set.
    const v = viewer(0)
    v.want('a.txt')
    attachEditors(v, new Set(['a.txt']))
    expect([...v.attached]).toEqual(['a.txt'])
  })

  it('leaves an already-attached file alone', () => {
    const v = viewer(0)
    v.want('a.txt')
    attachEditors(v, new Set(['a.txt']))
    const render = vi.spyOn(v.instance, 'render')
    attachEditors(v, new Set(['a.txt']))
    expect(render).not.toHaveBeenCalled()
  })

  it('reports rather than silently claiming a session it could not start', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = viewer(99)
    v.want('a.txt')
    attachEditors(v, new Set(['a.txt']))
    expect(err).toHaveBeenCalled()
  })

  it('does nothing when no file is being edited', () => {
    const v = viewer(0)
    const render = vi.spyOn(v.instance, 'render')
    attachEditors(v, new Set())
    expect(render).not.toHaveBeenCalled()
  })
})
