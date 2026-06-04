import { useEffect, useState } from 'react'
import type { Extension } from '@uiw/react-codemirror'
import { languages } from '@codemirror/language-data'

// Resolve a CodeMirror language extension by filename (or path). The lookup is
// async because @codemirror/language-data lazy-loads each language pack so we
// only pay for the ones actually opened. Returns an empty array when there's
// no match or while the pack is still loading.
export function useLanguageExtension(filePath: string | undefined): Extension[] {
  const [ext, setExt] = useState<Extension[]>([])
  useEffect(() => {
    if (!filePath) {
      setExt([])
      return
    }
    const slash = filePath.lastIndexOf('/')
    const filename = slash >= 0 ? filePath.slice(slash + 1) : filePath
    const desc =
      languages.find((l) => l.extensions.some((e) => filename.endsWith('.' + e))) ??
      languages.find((l) => l.filename?.test(filename))
    if (!desc) {
      setExt([])
      return
    }
    let cancelled = false
    desc
      .load()
      .then((support) => {
        if (!cancelled) setExt([support])
      })
      .catch(() => {
        if (!cancelled) setExt([])
      })
    return () => {
      cancelled = true
    }
  }, [filePath])
  return ext
}
