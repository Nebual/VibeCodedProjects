<script setup lang="ts">
import type { FoodRow } from '~/composables/useDiary'
import { BarcodeDetector as WasmBarcodeDetector, setZXingModuleOverrides } from 'barcode-detector/pure'
// The polyfill defaults to fetching its WASM binary from the jsDelivr CDN on
// first use. Point it at the copy Vite already bundles instead, so scanning
// doesn't depend on a third-party host being reachable.
import zxingReaderWasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'

setZXingModuleOverrides({
  locateFile: (path, prefix) => (path.endsWith('.wasm') ? zxingReaderWasmUrl : prefix + path),
})

const props = withDefaults(
  defineProps<{
    meal: string
    date: string | null
    /** Set when scanning an ingredient into a recipe rather than a meal. */
    recipe?: number | null
    /** Set when replacing an existing ingredient rather than adding one. */
    ingredient?: number | null
    /**
     * Extra query parameters to carry to the portion picker — the amount an
     * ingredient already has, so swapping its food doesn't reset it.
     */
    extra?: Record<string, string>
    /**
     * Capture the code instead of navigating to the food: emit `scanned(code)`
     * and stop (used by the new-food form, which fills its barcode field and
     * checks duplicates itself). Default on-points you straight at the food.
     */
    capture?: boolean
  }>(),
  { recipe: null, ingredient: null, extra: () => ({}), capture: false },
)

/** Where a scanned food goes — a meal, or the recipe we came from. */
const target = computed(() =>
  foodLinkQuery({
    meal: props.meal,
    date: props.date,
    recipe: props.recipe,
    ingredient: props.ingredient,
    extra: props.extra,
  }),
)
const emit = defineEmits<{ close: []; scanned: [code: string] }>()

const video = ref<HTMLVideoElement | null>(null)
const status = ref<'idle' | 'starting' | 'scanning' | 'denied' | 'looking-up'>('idle')
const manualCode = ref('')
const notFound = ref<string | null>(null)

let stream: MediaStream | null = null
let raf: number | undefined

/**
 * Prefers the native BarcodeDetector API (Chrome/Edge) since it's fast and
 * adds nothing to the bundle. Firefox and Safari never implemented it, so
 * there we fall back to the `barcode-detector` WASM polyfill (zxing-wasm
 * under the hood, ~1MB, only fetched once scanning actually starts) rather
 * than leaving those browsers with manual entry as the only option.
 */
function getDetectorCtor(): typeof WasmBarcodeDetector {
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    return (window as unknown as { BarcodeDetector: typeof WasmBarcodeDetector }).BarcodeDetector
  }
  return WasmBarcodeDetector
}

async function start() {
  status.value = 'starting'
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    })
    if (!video.value) return
    video.value.srcObject = stream
    await video.value.play()
    status.value = 'scanning'
    detectLoop()
  } catch {
    status.value = 'denied'
    stop()
  }
}

async function detectLoop() {
  const Detector = getDetectorCtor()
  const detector = new Detector({
    formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
  })

  const tick = async () => {
    if (status.value !== 'scanning' || !video.value) return
    try {
      const codes = await detector.detect(video.value)
      if (codes.length > 0 && codes[0].rawValue) {
        await lookup(codes[0].rawValue)
        return
      }
    } catch {
      // A transient decode failure is normal between frames; keep going.
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
}

async function lookup(code: string) {
  status.value = 'looking-up'
  notFound.value = null
  // Capture mode: hand the raw code to the parent (which fills a form field and
  // checks for duplicates itself) instead of navigating to the food.
  if (props.capture) {
    stop()
    emit('scanned', code.trim())
    return
  }
  try {
    const { food } = await $fetch<{ food: FoodRow }>(`/api/foods/barcode/${code}`)
    stop()
    await navigateTo(`/food/${food.id}?${target.value}`)
  } catch {
    notFound.value = code
    // Resume scanning so they can try another angle or a different product.
    status.value = stream ? 'scanning' : 'idle'
    if (status.value === 'scanning') detectLoop()
  }
}

function stop() {
  if (raf) cancelAnimationFrame(raf)
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

function close() {
  stop()
  emit('close')
}

onMounted(start)
onBeforeUnmount(stop)
</script>

<template>
  <div class="modal modal-open" role="dialog" aria-label="Scan barcode">
    <div class="modal-box max-w-md">
      <h3 class="font-semibold text-lg mb-3">Scan a barcode</h3>

      <div class="relative rounded-box overflow-hidden bg-black aspect-[4/3] grid place-items-center">
        <video
          ref="video"
          class="w-full h-full object-cover"
          muted
          playsinline
        />
        <!-- Alignment guide -->
        <div
          v-if="status === 'scanning'"
          class="absolute inset-x-6 h-24 border-2 border-primary/80 rounded-lg"
        />
        <div
          v-if="status === 'starting'"
          class="absolute inset-0 grid place-items-center text-white/70"
        >
          <span class="loading loading-spinner" />
        </div>
      </div>

      <div v-if="status === 'denied'" class="alert alert-warning mt-3 text-sm">
        <span>Camera access was blocked or unavailable. Enter the barcode manually below.</span>
      </div>
      <div v-if="notFound" class="alert alert-error mt-3 text-sm">
        <span>No food found for {{ notFound }}. Try again or create a custom food.</span>
      </div>

      <form class="join w-full mt-3" @submit.prevent="lookup(manualCode)">
        <input
          v-model="manualCode"
          type="text"
          inputmode="numeric"
          placeholder="Enter barcode number"
          class="input input-bordered join-item flex-1"
        >
        <button
          class="btn btn-primary join-item"
          type="submit"
          :disabled="manualCode.length < 6 || status === 'looking-up'"
        >
          <span v-if="status === 'looking-up'" class="loading loading-spinner loading-xs" />
          {{ capture ? 'Use' : 'Look up' }}
        </button>
      </form>

      <div class="modal-action">
        <NuxtLink
          v-if="!capture"
          :to="`/food/new?${target}&barcode=${manualCode || notFound || ''}`"
          class="btn btn-ghost btn-sm"
        >
          Create custom food
        </NuxtLink>
        <button class="btn btn-sm" @click="close">Close</button>
      </div>
    </div>
    <div class="modal-backdrop bg-black/50" @click="close" />
  </div>
</template>
