import type {
  MediaCreateInput,
  MediaItem,
  MediaUpdateInput,
} from '~~/shared/types'

// Central store for the media the current user can see, plus the mutations
// (create / update / delete) that talk to the YAML-backed API.
export const useMedia = () => {
  const { name } = useUser()
  const items = useState<MediaItem[]>('media-items', () => [])
  const pending = useState<boolean>('media-pending', () => false)
  const error = useState<string>('media-error', () => '')

  async function refresh() {
    if (!name.value) {
      items.value = []
      return
    }
    pending.value = true
    error.value = ''
    try {
      const data = await $fetch<{ items: MediaItem[] }>('/api/media', {
        query: { user: name.value },
      })
      items.value = data.items
    } catch (e: unknown) {
      error.value = (e as Error).message || 'Failed to load media'
    } finally {
      pending.value = false
    }
  }

  async function create(input: Omit<MediaCreateInput, 'owner'>) {
    const data = await $fetch<{ item: MediaItem }>('/api/media', {
      method: 'POST',
      body: { ...input, owner: name.value },
    })
    await refresh()
    return data.item
  }

  async function update(id: string, patch: Omit<MediaUpdateInput, 'actor'>) {
    const data = await $fetch<{ item: MediaItem }>(`/api/media/${id}`, {
      method: 'PUT',
      body: { ...patch, actor: name.value },
    })
    await refresh()
    return data.item
  }

  async function remove(id: string) {
    await $fetch(`/api/media/${id}`, {
      method: 'DELETE',
      query: { actor: name.value },
    })
    await refresh()
  }

  /** Convenience: bump lastActivityAt to now (e.g. "I played this today"). */
  async function touch(id: string) {
    return update(id, { lastActivityAt: new Date().toISOString() })
  }

  // My own entries vs. entries shared with me by others.
  const mine = computed(() =>
    items.value.filter(
      (m) => m.owner.toLowerCase() === name.value.trim().toLowerCase(),
    ),
  )
  const sharedWithMe = computed(() =>
    items.value.filter(
      (m) => m.owner.toLowerCase() !== name.value.trim().toLowerCase(),
    ),
  )

  // Someone else's media that names me specifically. Narrower than
  // sharedWithMe, which also covers a friend's untagged items.
  const taggedIn = computed(() => {
    const me = name.value.trim().toLowerCase()
    return items.value.filter(
      (m) =>
        m.owner.trim().toLowerCase() !== me &&
        m.companions.some((c) => c.trim().toLowerCase() === me),
    )
  })

  function canEdit(item: MediaItem) {
    return item.owner.trim().toLowerCase() === name.value.trim().toLowerCase()
  }

  return {
    items,
    mine,
    sharedWithMe,
    taggedIn,
    pending,
    error,
    refresh,
    create,
    update,
    remove,
    touch,
    canEdit,
  }
}
