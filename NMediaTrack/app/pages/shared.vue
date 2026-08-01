<script setup lang="ts">
import type { MediaItem } from '~~/shared/types'

const { sharedWithMe, pending } = useMedia()

// Group the shared items by their owner so each person's list is its own section.
const byOwner = computed(() => {
  const groups = new Map<string, MediaItem[]>()
  for (const item of sharedWithMe.value) {
    const list = groups.get(item.owner) ?? []
    list.push(item)
    groups.set(item.owner, list)
  }
  for (const [, list] of groups) {
    list.sort((a, b) =>
      (b.lastActivityAt || b.createdAt).localeCompare(a.lastActivityAt || a.createdAt),
    )
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
})
</script>

<template>
  <div>
    <div class="mb-6">
      <h1 class="text-3xl font-bold">Shared with you</h1>
      <p class="mt-1 text-sm opacity-70">
        Once someone tags you on any of their media, you can view their whole list here.
      </p>
    </div>

    <div v-if="pending && !sharedWithMe.length" class="flex justify-center py-20">
      <span class="loading loading-spinner loading-lg" />
    </div>

    <div
      v-else-if="!sharedWithMe.length"
      class="rounded-box border border-dashed border-base-300 py-20 text-center"
    >
      <div class="text-5xl">🤝</div>
      <h2 class="mt-4 text-xl font-semibold">Nothing shared yet</h2>
      <p class="mt-1 opacity-70">
        When a friend tags your name in any of their media, their whole list
        shows up here — handy for finding a game to play together.
      </p>
    </div>

    <div v-else class="space-y-10">
      <section v-for="[owner, list] in byOwner" :key="owner">
        <div class="mb-3 flex items-center gap-3">
          <div class="avatar avatar-placeholder">
            <div class="w-10 rounded-full bg-secondary text-secondary-content">
              <span class="text-lg">{{ owner.charAt(0).toUpperCase() }}</span>
            </div>
          </div>
          <div>
            <h2 class="text-xl font-semibold">{{ owner }}'s list</h2>
            <p class="text-xs opacity-60">
              {{ list.length }} shared item{{ list.length === 1 ? '' : 's' }}
            </p>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MediaCard v-for="item in list" :key="item.id" :item="item" />
        </div>
      </section>
    </div>
  </div>
</template>
