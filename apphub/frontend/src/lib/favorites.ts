import { useCallback, useEffect, useState } from 'react'

// Per-user favorite templates, persisted in the browser. Keyed by username so shared
// machines keep favorites separate. (A backend-persisted version is a later enhancement.)
const KEY = (user: string) => `apphub.favorites.${user || 'anon'}`

function read(user: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY(user)) || '[]')
  } catch {
    return []
  }
}

export function useFavorites(user: string) {
  const [ids, setIds] = useState<string[]>(() => read(user))

  useEffect(() => setIds(read(user)), [user])

  const toggle = useCallback(
    (templateId: string) => {
      setIds((prev) => {
        const next = prev.includes(templateId) ? prev.filter((x) => x !== templateId) : [...prev, templateId]
        try {
          localStorage.setItem(KEY(user), JSON.stringify(next))
        } catch {
          /* storage may be unavailable */
        }
        return next
      })
    },
    [user],
  )

  const isFavorite = useCallback((templateId: string) => ids.includes(templateId), [ids])
  return { favoriteIds: ids, toggle, isFavorite }
}
