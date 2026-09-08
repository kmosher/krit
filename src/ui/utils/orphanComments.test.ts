import { describe, it, expect } from 'vitest'
import { orphanCommentPaths } from './orphanComments'
import { makeComment } from '../test-utils'

describe('orphanCommentPaths', () => {
  it('names the files the surface is not rendering', () => {
    const paths = orphanCommentPaths(
      [
        makeComment({ id: 'a', filePath: 'kept.ts' }),
        makeComment({ id: 'b', filePath: 'gone.ts' }),
        makeComment({ id: 'c', filePath: 'gone.ts' }),
      ],
      new Set(['kept.ts', 'untouched.ts']),
    )
    expect([...paths]).toEqual(['gone.ts'])
  })

  it('is empty when every comment has somewhere to render', () => {
    const paths = orphanCommentPaths([makeComment({ filePath: 'a.ts' })], new Set(['a.ts']))
    expect(paths.size).toBe(0)
  })
})
