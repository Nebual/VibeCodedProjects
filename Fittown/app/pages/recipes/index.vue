<script setup lang="ts">
import type { RecipeSummary } from '~/composables/useRecipes'

useHead({ title: 'Recipes · Fittown' })

const router = useRouter()
const { data, refresh } = await useFetch<{ recipes: RecipeSummary[] }>('/api/recipes', {
  default: () => ({ recipes: [] }),
})

const newName = ref('')
const creating = ref(false)
const error = ref<string | null>(null)

/** Set server-side from NUXT_RECIPE_OCR_BASE_URL; empty hides the Scan button entirely. */
const { public: publicConfig } = useRuntimeConfig()
const photoImportEnabled = computed(() => Boolean(publicConfig.recipeOcrEnabled))

/**
 * Create the recipe before the editor opens, rather than holding a draft in the
 * client: adding an ingredient means a round trip through the food search, and
 * an unsaved recipe would not survive it.
 */
async function create() {
  const name = newName.value.trim()
  if (name.length < 2 || creating.value) return
  creating.value = true
  error.value = null
  try {
    const { id } = await $fetch<{ id: number }>('/api/recipes', {
      method: 'POST',
      body: { name },
    })
    await router.push(`/recipes/${id}`)
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not create'
    creating.value = false
    await refresh()
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <h1 class="font-semibold text-lg flex-1">Recipes</h1>
    </header>

    <section class="card bg-base-100 shadow-sm">
      <div class="card-body p-4 gap-3">
        <div class="flex gap-2">
          <NuxtLink
            v-if="photoImportEnabled"
            to="/recipes/import?tab=photo"
            class="btn btn-outline btn-sm flex-1 gap-1.5"
          >
            <AppIcon name="camera" class="w-4 h-4" />
            Scan
          </NuxtLink>
          <NuxtLink to="/recipes/import?tab=url" class="btn btn-outline btn-sm flex-1 gap-1.5">
            <AppIcon name="link" class="w-4 h-4" />
            Link
          </NuxtLink>
          <NuxtLink to="/recipes/import?tab=paste" class="btn btn-outline btn-sm flex-1 gap-1.5">
            <AppIcon name="clipboard" class="w-4 h-4" />
            Paste
          </NuxtLink>
        </div>

        <div class="divider -mt-1 -mb-3 text-xs text-base-content/40">or start from scratch</div>

        <label class="form-control">
          <span class="label-text text-xs mb-1">New recipe</span>
          <div class="flex gap-2">
            <input
              v-model="newName"
              type="text"
              class="input input-bordered flex-1 min-w-0"
              placeholder="Grandma’s chili"
              @keyup.enter="create"
            >
            <button
              class="btn btn-primary gap-2"
              :disabled="creating || newName.trim().length < 2"
              @click="create"
            >
              <span v-if="creating" class="loading loading-spinner loading-sm" />
              <AppIcon v-else name="plus" class="w-4 h-4" />
              Create
            </button>
          </div>
        </label>
        <p v-if="error" class="text-xs text-error">{{ error }}</p>
      </div>
    </section>

    <div class="card bg-base-100 shadow-sm overflow-hidden">
      <ul v-if="data.recipes.length" class="flex flex-col divide-y divide-base-200">
        <li v-for="recipe in data.recipes" :key="recipe.id">
          <NuxtLink
            :to="`/recipes/${recipe.id}`"
            class="flex items-center gap-3 px-3 py-2.5 hover:bg-base-200 transition-colors"
          >
            <div class="flex-1 min-w-0">
              <div class="font-medium text-sm truncate">{{ recipe.name }}</div>
              <div class="text-xs text-base-content/60 truncate tabular">
                <template v-if="recipe.ingredient_count === 0">No ingredients yet</template>
                <template v-else>
                  {{ recipe.ingredient_count }}
                  {{ recipe.ingredient_count === 1 ? 'ingredient' : 'ingredients' }}
                  ·
                  {{ recipe.recipe_servings ?? 1 }}
                  {{ (recipe.recipe_servings ?? 1) === 1 ? 'serving' : 'servings' }}
                  <template v-if="recipe.kcal_per_serving !== null">
                    · {{ Math.round(recipe.kcal_per_serving) }} kcal each
                  </template>
                </template>
              </div>
            </div>
            <AppIcon name="chevronRight" class="w-4 h-4 text-base-content/30 shrink-0" />
          </NuxtLink>
        </li>
      </ul>

      <p v-else class="p-6 text-center text-sm text-base-content/50">
        A recipe is a mixture of foods you log as one thing — name it, add what goes
        in, and say how many servings it makes.
      </p>
    </div>
  </div>
</template>
