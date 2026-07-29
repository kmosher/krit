import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The server counts a subscriber as a browser only when it asks for
// `role=ui`, and browser presence is what holds the review server alive and
// enables the Done-reviewing button. Drop the parameter and nothing fails
// loudly: the review just never ends, and the counts sit at zero.
//
// That failure spans two languages, so neither side's own tests can catch it
// — the Rust test pins the default, and this pins the declaration. Reading the
// source is deliberate: mounting the hooks would prove that whatever they do
// today is what they do today, which is exactly the tautology worth avoiding.
const SUBSCRIBERS = ['src/ui/hooks/useDiff.ts', 'src/ui/hooks/useReviewState.ts']

describe('SSE subscribers identify themselves as browsers', () => {
  for (const path of SUBSCRIBERS) {
    it(`${path} opens /api/events with role=ui`, () => {
      const source = readFileSync(path, 'utf8')
      const opens = [...source.matchAll(/new EventSource\(\s*'([^']*)'/g)].map((m) => m[1])

      expect(opens.length).toBeGreaterThan(0)
      for (const url of opens) {
        expect(url).toContain('/api/events')
        expect(url).toContain('role=ui')
      }
    })
  }

  for (const path of SUBSCRIBERS) {
    it(`${path} closes its stream when the review ends`, () => {
      // Done reviewing stops the server by letting the browser count fall to
      // zero. One subscriber that keeps its stream open is enough to hold the
      // count above zero and put the wait back — and it would look like a
      // server bug, not a missed teardown here.
      // Matched as a call, not a mention: importing the helper and never
      // registering is exactly the shape this is guarding against.
      const source = readFileSync(path, 'utf8')
      expect(source).toMatch(/onReviewSessionEnd\(\s*\(\)\s*=>[^)]*\.close\(\)/)
    })
  }

  it('has no EventSource outside the files listed above', () => {
    // Guards the list itself. Without this, a third subscriber added anywhere
    // in src/ui would satisfy every assertion above while going uncounted —
    // the tests would stay green and the review server would stop exiting.
    const found: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (readFileSync(path, 'utf8').includes('new EventSource(')) found.push(path)
        }
      }
    }
    walk('src/ui')

    expect(found.sort()).toEqual([...SUBSCRIBERS].sort())
  })
})
