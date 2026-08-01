<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: number
    readonly?: boolean
    size?: 'sm' | 'md' | 'lg'
  }>(),
  { readonly: false, size: 'md' },
)
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

const sizeClass = computed(
  () =>
    ({ sm: 'rating-sm', md: 'rating-md', lg: 'rating-lg' })[props.size],
)

function set(v: number) {
  if (props.readonly) return
  // Click the same star twice to clear back to zero.
  emit('update:modelValue', props.modelValue === v ? 0 : v)
}
</script>

<template>
  <div
    class="rating gap-0.5"
    :class="[sizeClass, { 'pointer-events-none': readonly }]"
  >
    <button
      v-for="star in 5"
      :key="star"
      type="button"
      class="mask mask-star-2 bg-warning transition-opacity"
      :class="star <= modelValue ? 'opacity-100' : 'opacity-25'"
      :aria-label="`${star} star${star === 1 ? '' : 's'}`"
      @click="set(star)"
    />
  </div>
</template>
