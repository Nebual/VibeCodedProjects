<script setup lang="ts">
import { TYPE_META } from '~~/shared/types'
import type { MediaItem } from '~~/shared/types'

const { mine } = useMedia()

const minStars = ref(0)

const reviewed = computed(() =>
  mine.value
    .filter((m): m is MediaItem & { review: NonNullable<MediaItem['review']> } =>
      !!m.review && m.review.stars >= minStars.value,
    )
    .sort((a, b) => {
      if (b.review.stars !== a.review.stars) return b.review.stars - a.review.stars
      return b.review.updatedAt.localeCompare(a.review.updatedAt)
    }),
)

const avg = computed(() => {
  const withStars = mine.value.filter((m) => m.review)
  if (!withStars.length) return 0
  return withStars.reduce((s, m) => s + (m.review?.stars ?? 0), 0) / withStars.length
})
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
      <div v-if="mine.some((m) => m.review)" class="stats bg-base-100 shadow">
        <div class="stat py-2">
          <div class="stat-title text-xs">Reviewed</div>
          <div class="stat-value text-2xl">{{ mine.filter((m) => m.review).length }}</div>
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
        v-for="item in reviewed"
        :key="item.id"
        class="card border border-base-300 bg-base-100 shadow-sm"
      >
        <div class="card-body gap-2 p-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-3">
              <span class="text-2xl">{{ TYPE_META[item.type].icon }}</span>
              <div>
                <h3 class="text-lg font-semibold leading-tight">{{ item.title }}</h3>
                <span class="text-xs opacity-60">{{ TYPE_META[item.type].label }}</span>
              </div>
            </div>
            <StarRating :model-value="item.review.stars" readonly />
          </div>
          <p v-if="item.review.message" class="text-[15px] leading-relaxed">
            “{{ item.review.message }}”
          </p>
          <p class="text-xs opacity-50">Reviewed {{ shortDate(item.review.updatedAt) }}</p>
        </div>
      </article>
    </div>
  </div>
</template>
