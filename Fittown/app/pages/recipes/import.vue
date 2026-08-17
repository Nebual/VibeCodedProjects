<script setup lang="ts">
import { parseIngredientList } from '#shared/ingredientText'
import { splitPastedSections } from '#shared/recipeText'
import { roundGrams } from '#shared/portions'
import { MAX_INGREDIENTS } from '#shared/recipes'

/**
 * Importing a recipe, two ways.
 *
 * The paste tab parses **in the browser, as you type**, and shows what it made
 * of each line before anything is saved. That preview is the feature: the
 * parser has to guess, and a guess you can see and correct beats one that only
 * shows up as a wrong calorie count a week later. The same pure module runs on
 * the server, so what you see here is what gets stored.
 */

useHead({ title: 'Import a recipe · Fittown' })

const router = useRouter()

const tab = ref<'paste' | 'url'>('paste')
const busy = ref(false)
const error = ref<string | null>(null)

// --- paste -------------------------------------------------------------------

const pasteName = ref('')
const pasteText = ref('')

const sections = computed(() => splitPastedSections(pasteText.value))
const preview = computed(() => parseIngredientList(sections.value.ingredients))
const tooMany = computed(() => preview.value.length > MAX_INGREDIENTS)

/** What the row will show once it's saved: an amount, or nothing at all. */
function amountText(line: { grams: number; serving_label: string | null; serving_count: number | null }) {
  if (line.serving_label && line.serving_count) {
    return `${Number(line.serving_count.toFixed(2))} × ${line.serving_label} · ${roundGrams(line.grams)} g`
  }
  return line.grams > 0 ? `${roundGrams(line.grams)} g` : 'no amount'
}

async function importPaste() {
  if (!preview.value.length || busy.value || tooMany.value) return
  busy.value = true
  error.value = null
  try {
    const { id } = await $fetch<{ id: number }>('/api/recipes/import/text', {
      method: 'POST',
      body: { name: pasteName.value.trim() || undefined, text: pasteText.value },
    })
    await router.push(`/recipes/${id}`)
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not import that'
    busy.value = false
  }
}

// --- url ---------------------------------------------------------------------

const url = ref('')

async function importUrl() {
  const address = url.value.trim()
  if (!address || busy.value) return
  busy.value = true
  error.value = null
  try {
    const { id } = await $fetch<{ id: number }>('/api/recipes/import/url', {
      method: 'POST',
      body: { url: address },
    })
    await router.push(`/recipes/${id}`)
  } catch (err) {
    error.value = (err as { statusMessage?: string }).statusMessage ?? 'Could not read that page'
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <header class="flex items-center gap-2">
      <button class="btn btn-ghost btn-sm btn-square" aria-label="Back" @click="router.back()">
        <AppIcon name="chevronLeft" class="w-5 h-5" />
      </button>
      <h1 class="font-semibold text-lg flex-1">Import a recipe</h1>
    </header>

    <div role="tablist" class="tabs tabs-box">
      <button
        role="tab"
        class="tab flex-1"
        :class="{ 'tab-active': tab === 'paste' }"
        @click="tab = 'paste'; error = null"
      >
        Paste a list
      </button>
      <button
        role="tab"
        class="tab flex-1"
        :class="{ 'tab-active': tab === 'url' }"
        @click="tab = 'url'; error = null"
      >
        From a link
      </button>
    </div>

    <!-- Paste ------------------------------------------------------------->
    <template v-if="tab === 'paste'">
      <section class="card bg-base-100 shadow-sm">
        <div class="card-body p-4 gap-3">
          <label class="form-control">
            <span class="label-text text-xs mb-1">Name (optional)</span>
            <input
              v-model="pasteName"
              type="text"
              class="input input-bordered w-full"
              placeholder="Balsamic vinaigrette"
            >
          </label>

          <label class="form-control">
            <span class="label-text text-xs mb-1">Ingredients, one per line</span>
            <textarea
              v-model="pasteText"
              class="textarea textarea-bordered w-full min-h-40 text-sm leading-relaxed font-mono"
              placeholder="1/4c avocado oil&#10;45g balsamic vinegar&#10;pinch of salt&#10;a lot of oregano&#10;garlic powder"
            />
          </label>

          <p class="text-xs text-base-content/50">
            Anything without a clear amount is added at 0 g with a note, so you can
            decide what it should be.
          </p>
        </div>
      </section>

      <!-- The preview. Shown before saving, because every line here is a guess. -->
      <section v-if="preview.length" class="card bg-base-100 shadow-sm">
        <div class="card-body p-0">
          <header class="flex items-center justify-between px-4 pt-3 pb-2">
            <h2 class="font-semibold text-sm">
              {{ preview.length }} {{ preview.length === 1 ? 'ingredient' : 'ingredients' }}
            </h2>
            <span class="text-xs text-base-content/50">before matching</span>
          </header>

          <ul class="divide-y divide-base-200">
            <li v-for="(line, i) in preview" :key="i" class="flex items-baseline gap-3 px-4 py-2">
              <div class="flex-1 min-w-0">
                <div class="truncate text-sm">{{ line.name }}</div>
                <div v-if="line.note" class="text-xs text-base-content/50 truncate">{{ line.note }}</div>
              </div>
              <div
                class="text-xs tabular shrink-0"
                :class="line.grams > 0 ? 'text-base-content/70' : 'text-warning'"
              >
                {{ amountText(line) }}
              </div>
            </li>
          </ul>

          <p v-if="sections.instructions" class="px-4 py-2 text-xs text-base-content/50 border-t border-base-200">
            The instructions in your paste will be kept too.
          </p>
        </div>
      </section>

      <p v-if="tooMany" class="text-xs text-error">
        That's {{ preview.length }} ingredients; a recipe can hold {{ MAX_INGREDIENTS }}.
      </p>
      <p v-if="error" class="text-xs text-error">{{ error }}</p>

      <button
        class="btn btn-primary gap-2"
        :disabled="busy || !preview.length || tooMany"
        @click="importPaste"
      >
        <span v-if="busy" class="loading loading-spinner loading-sm" />
        <AppIcon v-else name="plus" class="w-4 h-4" />
        Create recipe
      </button>
    </template>

    <!-- URL --------------------------------------------------------------->
    <template v-else>
      <section class="card bg-base-100 shadow-sm">
        <div class="card-body p-4 gap-3">
          <label class="form-control">
            <span class="label-text text-xs mb-1">Recipe address</span>
            <input
              v-model="url"
              type="url"
              inputmode="url"
              class="input input-bordered w-full"
              placeholder="https://www.loveandlemons.com/balsamic-vinaigrette/"
              @keyup.enter="importUrl"
            >
          </label>

          <p class="text-xs text-base-content/50">
            We'll take the ingredients, the method, the times and the yield, and keep
            a link back to the original at the bottom of the instructions. Ingredients
            we can't identify are added as notes for you to sort out.
          </p>
        </div>
      </section>

      <p v-if="error" class="text-xs text-error">{{ error }}</p>

      <button class="btn btn-primary gap-2" :disabled="busy || !url.trim()" @click="importUrl">
        <span v-if="busy" class="loading loading-spinner loading-sm" />
        <AppIcon v-else name="link" class="w-4 h-4" />
        Import
      </button>
    </template>
  </div>
</template>
