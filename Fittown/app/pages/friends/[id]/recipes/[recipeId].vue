<script setup lang="ts">
import { friendDisplayName } from '#shared/friends'
import { apiError, type FriendPerson } from '~/composables/useFriends'
import type { RecipeDetail } from '~/composables/useRecipes'

/**
 * One of a friend's recipes.
 *
 * Both buttons copy. "Add recipe" leaves you on your own copy to edit; "Log
 * food" copies and goes straight to the portion picker, which is the same
 * screen you'd reach from search. Logging their row directly would look
 * simpler and would mean their next edit silently rewrites your Tuesday.
 */

const route = useRoute()
const router = useRouter()
const today = useToday()

const friendId = computed(() => Number(route.params.id))
const recipeId = computed(() => Number(route.params.recipeId))

/** Carried through from search so "Log food" lands in the meal you came from. */
const meal = computed(() => (route.query.meal as string) || 'snack')
const date = computed(() => (route.query.d as string) || today.value)

const { data, error } = await useFetch<RecipeDetail & { friend: FriendPerson }>(
  () => `/api/friends/${friendId.value}/recipes/${recipeId.value}`,
)

const ownerName = computed(() => (data.value?.friend ? friendDisplayName(data.value.friend) : null))
useHead({ title: () => `${data.value?.recipe?.name ?? 'Recipe'} · Fittown` })

const busy = ref(false)
const copyError = ref<string | null>(null)

async function copyRecipe(): Promise<number | null> {
  busy.value = true
  copyError.value = null
  try {
    const copy = await $fetch<{ id: number }>('/api/recipes/copy', {
      method: 'POST',
      body: { friend_id: friendId.value, recipe_id: recipeId.value },
    })
    return copy.id
  } catch (err) {
    copyError.value = apiError(err, 'Could not copy that recipe')
    return null
  } finally {
    busy.value = false
  }
}

async function addToMine() {
  const id = await copyRecipe()
  if (id) await router.push(`/recipes/${id}`)
}

async function logIt() {
  const id = await copyRecipe()
  if (!id) return
  const params = new URLSearchParams({ meal: meal.value })
  if (date.value) params.set('d', date.value)
  await router.push(`/food/${id}?${params}`)
}
</script>

<template>
  <div v-if="error" class="alert alert-error">
    <span>{{ error.statusMessage || 'That recipe isn’t available.' }}</span>
  </div>

  <div v-else-if="data" class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold flex-1 truncate">{{ data.recipe.name }}</h1>
      <span v-if="busy" class="loading loading-spinner loading-sm" />
    </header>

    <RecipeReadOnly :detail="data" :owner-name="ownerName">
      <template #actions>
        <div class="flex flex-col gap-2">
          <p v-if="copyError" class="text-xs text-error">{{ copyError }}</p>
          <div class="flex gap-2">
            <button class="btn btn-outline flex-1 gap-2" :disabled="busy" @click="addToMine">
              <AppIcon name="plus" class="w-4 h-4" />
              Add recipe
            </button>
            <button
              class="btn btn-primary flex-1 gap-2"
              :disabled="busy || !data.recipe.serving_grams"
              @click="logIt"
            >
              <AppIcon name="plus" class="w-4 h-4" />
              Log food
            </button>
          </div>
          <p class="text-xs text-base-content/50">
            Both take a copy into your own recipes — {{ ownerName }}’s stays theirs, and
            later edits of theirs won’t change yours.
          </p>
        </div>
      </template>
    </RecipeReadOnly>
  </div>
</template>
