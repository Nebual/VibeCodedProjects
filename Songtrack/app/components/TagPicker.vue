<script setup lang="ts">
const model = defineModel<string[]>({ default: () => [] })

const { data: existingTags } = await useFetch<{ id: string, name: string }[]>('/api/tags')

const query = ref('')
const showSuggestions = ref(false)

const suggestions = computed(() => {
  const q = query.value.trim().toLowerCase()
  return (existingTags.value ?? [])
    .map(t => t.name)
    .filter(name => !model.value.includes(name))
    .filter(name => !q || name.toLowerCase().includes(q))
    .slice(0, 8)
})

function addTag(name: string) {
  const trimmed = name.trim()
  if (!trimmed || model.value.includes(trimmed)) return
  model.value = [...model.value, trimmed]
  query.value = ''
  showSuggestions.value = false
}

function removeTag(name: string) {
  model.value = model.value.filter(t => t !== name)
}

function onBlur() {
  setTimeout(() => (showSuggestions.value = false), 150)
}

function onEnter() {
  if (suggestions.value.length && query.value.trim()) {
    addTag(suggestions.value[0]!)
  } else {
    addTag(query.value)
  }
}

/** Called by the parent right before it saves, so unsubmitted text in the box isn't silently lost. */
function commitPending() {
  if (query.value.trim()) addTag(query.value)
}

defineExpose({ commitPending })
</script>

<template>
  <div class="relative">
    <div class="flex flex-wrap gap-1 mb-1">
      <span v-for="name in model" :key="name" class="badge badge-primary gap-1">
        {{ name }}
        <button type="button" class="ml-1" @click="removeTag(name)">✕</button>
      </span>
    </div>
    <input
      v-model="query"
      type="text"
      placeholder="Add tags…"
      class="input input-bordered input-sm w-full"
      @focus="showSuggestions = true"
      @blur="onBlur"
      @keydown.enter.prevent="onEnter"
    >
    <ul
      v-if="showSuggestions && suggestions.length"
      class="absolute z-10 mt-1 w-full menu bg-base-100 rounded-box shadow max-h-48 overflow-auto flex-nowrap"
    >
      <li v-for="name in suggestions" :key="name">
        <button type="button" @mousedown.prevent="addTag(name)">{{ name }}</button>
      </li>
    </ul>
  </div>
</template>
