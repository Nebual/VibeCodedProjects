<script setup lang="ts">
import { apiError } from '~/composables/useFriends'
import type { RecipeDetail } from '~/composables/useRecipes'

/**
 * A shared recipe, readable by anyone with the link.
 *
 * The one page in the app that doesn't require signing in — `/r/…` is listed
 * in the auth middleware's public prefixes, and the endpoint behind it takes a
 * token rather than an id. A visitor who is signed in gets the same two copy
 * actions a friend does; one who isn't gets an honest sign-in prompt instead of
 * a button that fails.
 */
definePageMeta({ layout: 'public' })

const route = useRoute()
const router = useRouter()
const { loggedIn } = useUserSession()
const today = useToday()

const token = computed(() => String(route.params.token))

const { data, error } = await useFetch<RecipeDetail & { owner: { name: string } }>(
  () => `/api/shared/recipes/${token.value}`,
)

useHead({ title: () => `${data.value?.recipe?.name ?? 'Shared recipe'} · Fittown` })

const busy = ref(false)
const copyError = ref<string | null>(null)

async function copyRecipe(): Promise<number | null> {
  busy.value = true
  copyError.value = null
  try {
    const copy = await $fetch<{ id: number }>('/api/recipes/copy', {
      method: 'POST',
      body: { token: token.value },
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
  const params = new URLSearchParams({ meal: 'snack' })
  if (today.value) params.set('d', today.value)
  await router.push(`/food/${id}?${params}`)
}
</script>

<template>
  <div v-if="error" class="card bg-base-100 shadow-sm">
    <div class="card-body items-center text-center gap-2">
      <h1 class="font-semibold text-lg">Recipe unavailable</h1>
      <p class="text-sm text-base-content/60">
        {{ error.statusMessage || 'This link doesn’t point at a recipe.' }}
      </p>
    </div>
  </div>

  <div v-else-if="data" class="flex flex-col gap-3">
    <header>
      <h1 class="font-semibold text-lg">{{ data.recipe.name }}</h1>
      <p class="text-sm text-base-content/60">Shared by {{ data.owner.name }}</p>
    </header>

    <RecipeReadOnly :detail="data" :owner-name="data.owner.name">
      <template #actions>
        <div class="flex flex-col gap-2">
          <p v-if="copyError" class="text-xs text-error">{{ copyError }}</p>

          <div v-if="loggedIn" class="flex gap-2">
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

          <NuxtLink
            v-else
            :to="{ path: '/login', query: { redirect: route.fullPath } }"
            class="btn btn-primary gap-2"
          >
            Sign in to save this recipe
          </NuxtLink>
        </div>
      </template>
    </RecipeReadOnly>
  </div>
</template>
