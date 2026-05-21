import { useQuery } from '@tanstack/react-query'

interface FileTextResponse {
  contents?: string
  binary?: boolean
  oversize?: boolean
  size?: number
  cap?: number
}

async function fetchFileText(
  path: string,
  ref: string,
  force: boolean,
): Promise<FileTextResponse | null> {
  const url =
    `/api/file-text?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}` +
    (force ? '&force=true' : '')
  const res = await fetch(url)
  // 404 = the file genuinely doesn't exist at this ref (new file → no base; deleted → no head).
  // Not an error; we return null so the caller can pass undefined to the renderer.
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to fetch ${path} @ ${ref}: ${res.status}`)
  return res.json()
}

interface UseFileContentsResult {
  baseContents: string | undefined
  headContents: string | undefined
  loading: boolean
  error: Error | null
  /** Either side was rejected as too large (server soft-cap); the user can opt in via `force`. */
  oversize: boolean
  /** Either side was detected as binary by the server's NUL-byte sniff. */
  binary: boolean
  /** Largest of the two sides' sizes, in bytes — for "this file is X MB" prompts. */
  size: number
}

/**
 * Lazily fetch both base and head versions of a file as text, so the diff renderer
 * can use them to expand context lines beyond the patch's hunks. Pass `enabled: false`
 * (the default) until the consumer is sure the user cares (e.g. card has scrolled
 * into view). Pass `force: true` to bypass the server's 5MB soft cap.
 *
 * `baseRef`/`headRef` come from `/api/diff` — the refs the diff itself was computed
 * against. Passing mismatched refs (e.g. always HEAD when the diff is HEAD~3..HEAD)
 * causes the renderer to see "no diff" because the two file sides are identical.
 */
export function useFileContents(
  filePath: string,
  opts: { enabled: boolean; force: boolean; baseRef: string; headRef: string },
): UseFileContentsResult {
  const baseQ = useQuery({
    queryKey: ['file-text', filePath, opts.baseRef, opts.force],
    queryFn: () => fetchFileText(filePath, opts.baseRef, opts.force),
    enabled: opts.enabled && !!filePath && !!opts.baseRef,
    staleTime: Infinity,
  })
  const headQ = useQuery({
    queryKey: ['file-text', filePath, opts.headRef, opts.force],
    queryFn: () => fetchFileText(filePath, opts.headRef, opts.force),
    enabled: opts.enabled && !!filePath && !!opts.headRef,
    staleTime: Infinity,
  })

  return {
    baseContents: baseQ.data?.contents,
    headContents: headQ.data?.contents,
    loading: baseQ.isLoading || headQ.isLoading,
    error: (baseQ.error as Error | null) ?? (headQ.error as Error | null) ?? null,
    oversize: !!(baseQ.data?.oversize || headQ.data?.oversize),
    binary: !!(baseQ.data?.binary || headQ.data?.binary),
    size: Math.max(baseQ.data?.size ?? 0, headQ.data?.size ?? 0),
  }
}
