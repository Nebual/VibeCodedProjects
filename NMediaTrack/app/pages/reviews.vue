<script setup lang="ts">
import { reviewBy, TYPE_META } from '~~/shared/types'
import type { MediaItem, Review } from '~~/shared/types'

// Reviews you wrote — including ones on friends' entries, since a review
// belongs to its author rather than to the media entry.
const { items } = useMedia()
const { name } = useUser()

const minStars = ref(0)

interface Entry {
  item: MediaItem
  review: Review
}

const mineReviewed = computed<Entry[]>(() =>
  items.value
    .map((item) => {
      const review = reviewBy(item, name.value)
      return review ? { item, review } : null
    })
    .filter((e): e is Entry => e !== null),
)

const reviewed = computed(() =>
  mineReviewed.value
    .filter((e) => e.review.stars >= minStars.value)
    .sort(
      (a, b) =>
        b.review.stars - a.review.stars ||
        b.review.updatedAt.localeCompare(a.review.updatedAt),
    ),
)

const avg = computed(() => {
  if (!mineReviewed.value.length) return 0
  return (
    mineReviewed.value.reduce((s, e) => s + e.review.stars, 0) /
    mineReviewed.value.length
  )
})

const isOwn = (item: MediaItem) =>
  item.owner.trim().toLowerCase() === name.value.trim().toLowerCase()
</script>

<template>
  <div>
    <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-3xl font-bold">Your reviews</h1>
        <p class="mt-1 text-sm opacity-70">
          Why these mattered — so you can get excited all over again when you go to recommend one.
        </p>
      </div>
      <div v-if="mineReviewed.length" class="stats bg-base-100 shadow">
        <div class="stat py-2">
          <div class="stat-title text-xs">Reviewed</div>
          <div class="stat-value text-2xl">{{ mineReviewed.length }}</div>
        </div>
        <div class="stat py-2">
          <div class="stat-title text-xs">Avg rating</div>
          <div class="stat-value text-2xl">{{ avg.toFixed(1) }}★</div>
        </div>
      </div>
    </div>

    <div class="mb-6 flex items-center gap-2 text-sm">
      <span class="opacity-70">Show at least</span>
      <select v-model.number="minStars" class="select select-bordered select-sm">
        <option :value="0">any rating</option>
        <option :value="3">3★+</option>
        <option :value="4">4★+</option>
        <option :value="5">5★ only</option>
      </select>
    </div>

    <div
      v-if="!reviewed.length"
      class="rounded-box border border-dashed border-base-300 py-20 text-center"
    >
      <div class="text-5xl">✍️</div>
      <h2 class="mt-4 text-xl font-semibold">No reviews yet</h2>
      <p class="mt-1 opacity-70">
        Open any item in your library and leave a star rating with a note about why it stuck with you.
      </p>
    </div>

    <div v-else class="space-y-4">
      <article
        v-for="{ item, review } in reviewed"
        :key="item.id"
        class="card border-2 border-base-content/15 bg-base-100 shadow-sm"
      >
        <div class="card-body gap-2 p-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-3">
              <span class="text-2xl">{{ TYPE_META[item.type].icon }}</span>
              <div>
                <h3 class="text-lg font-semibold leading-tight">{{ item.title }}</h3>
                <span class="text-xs opacity-60">
                  {{ TYPE_META[item.type].label }}
                  <template v-if="!isOwn(item)"> · from {{ item.owner }}'s list</template>
                </span>
              </div>
            </div>
            <StarRating :model-value="review.stars" readonly />
          </div>
          <p v-if="review.message" class="text-[15px] leading-relaxed">
            “{{ review.message }}”
          </p>
          <p class="text-xs opacity-50">Reviewed {{ shortDate(review.updatedAt) }}</p>
        </div>
      </article>
    </div>
  </div>
</template>
