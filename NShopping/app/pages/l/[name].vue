<script setup lang="ts">
import { isBackupName, isReadableListName } from '#shared/listName'

const route = useRoute()
const name = String(route.params.name ?? '')

if (!isReadableListName(name)) {
  throw createError({ statusCode: 404, statusMessage: 'No such list', fatal: true })
}

useHead({ title: `${name} · NShoppingList` })

// Don't let a backup become the list you get bounced to from `/`.
onMounted(() => {
  if (!isBackupName(name)) localStorage.setItem('nshoppinglist:last', name)
})
</script>

<template>
  <ShoppingList :key="name" :name="name" />
</template>
