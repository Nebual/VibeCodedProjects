<script setup lang="ts">
// A simple tag-style input for "who are you consuming this with". Adds names as
// chips, suggests previously-seen people, and excludes the current user.
const props = defineProps<{ modelValue: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const { name } = useUser()
const draft = ref('')
const suggestions = ref<string[]>([])

onMounted(async () => {
  try {
    const data = await $fetch<{ people: string[] }>('/api/people', {
      query: { not: name.value },
    })
    suggestions.value = data.people
  } catch {
    suggestions.value = []
  }
})

const available = computed(() =>
  suggestions.value.filter(
    (p) =>
      !props.modelValue.some((c) => c.toLowerCase() === p.toLowerCase()) &&
      p.toLowerCase() !== name.value.trim().toLowerCase() &&
      (draft.value.trim() === '' ||
        p.toLowerCase().includes(draft.value.trim().toLowerCase())),
  ),
)

function add(person: string) {
  const v = person.trim()
  if (!v) return
  if (v.toLowerCase() === name.value.trim().toLowerCase()) {
    draft.value = ''
    return
  }
  if (!props.modelValue.some((c) => c.toLowerCase() === v.toLowerCase())) {
    emit('update:modelValue', [...props.modelValue, v])
  }
  draft.value = ''
}

function remove(person: string) {
  emit(
    'update:modelValue',
    props.modelValue.filter((c) => c !== person),
  )
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault()
    add(draft.value)
  } else if (e.key === 'Backspace' && draft.value === '' && props.modelValue.length) {
    remove(props.modelValue[props.modelValue.length - 1]!)
  }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-2 rounded-box border border-base-300 bg-base-100 p-2">
      <span
        v-for="person in modelValue"
        :key="person"
        class="badge badge-primary gap-1"
      >
        {{ person }}
        <button type="button" class="hover:opacity-70" @click="remove(person)">✕</button>
      </span>
      <input
        v-model="draft"
        type="text"
        class="min-w-[8rem] flex-1 bg-transparent px-1 outline-none"
        placeholder="Add a person…"
        @keydown="onKeydown"
      />
    </div>
    <div v-if="available.length" class="mt-2 flex flex-wrap gap-1">
      <button
        v-for="person in available.slice(0, 8)"
        :key="person"
        type="button"
        class="badge badge-outline badge-sm hover:badge-primary"
        @click="add(person)"
      >
        + {{ person }}
      </button>
    </div>
  </div>
</template>
