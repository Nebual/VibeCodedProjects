<template>
  <div class="bg-base-200 min-h-screen">
    <div class="navbar bg-base-100 shadow-sm">
      <div class="mx-auto flex w-full max-w-5xl items-center gap-3 px-4">
        <NuxtLink to="/" class="text-xl font-semibold tracking-tight">
          NAudio<span class="text-primary">Booker</span>
        </NuxtLink>
        <span class="text-base-content/50 hidden text-sm sm:inline">EPUB → audiobook</span>
        <div class="ml-auto">
          <ApiStatus />
        </div>
      </div>
    </div>

    <main class="mx-auto w-full max-w-5xl px-4 py-8">
      <NuxtPage />
    </main>
  </div>
</template>
