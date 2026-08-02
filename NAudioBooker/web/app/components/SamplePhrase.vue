<script setup lang="ts">
import type { BookDetail, ChapterText } from '~/types/api'

/**
 * What to speak when previewing a voice.
 *
 * The most useful sample is the book you are about to render: a voice that
 * sounds fine on a stock sentence can still be wrong for a particular author's
 * rhythm or vocabulary. So passages from the book itself are offered first, and
 * anything can be typed in.
 */

const text = defineModel<string>({ required: true })
const props = defineProps<{ bookId?: string }>()

interface Option { id: string, label: string, text: string }

/** Written to exercise the things narration actually stumbles on. */
const PRESETS: Option[] = [
  {
    id: 'preset-neutral',
    label: 'Neutral narration',
    text: 'The harbour lights came on one by one, and the town settled into '
      + 'evening. She had waited three years for this, and now that it was '
      + 'here, she found she had nothing at all to say.',
  },
  {
    id: 'preset-dialogue',
    label: 'Dialogue and attribution',
    text: '"You cannot be serious," he said, and then, more quietly, "tell me '
      + 'you are not serious." She only shrugged. "I have been serious since '
      + 'Tuesday."',
  },
  {
    id: 'preset-numbers',
    label: 'Numbers, dates and abbreviations',
    text: 'On 3rd March 1847, Dr. Ellis recorded 1,204 arrivals at St. Mary\'s '
      + 'dock, roughly 12% more than the previous quarter, at a cost of 8,750 '
      + 'pounds.',
  },
  {
    id: 'preset-long',
    label: 'Long sentence, many clauses',
    text: 'Although the road had been closed since the spring, and although '
      + 'everyone in the village knew perfectly well why, nobody had thought '
      + 'to mention it to the surveyors, who arrived on a Tuesday with maps '
      + 'that were already out of date.',
  },
]

/** How many of the selected chapters to offer a passage from. */
const SAMPLE_CHAPTERS = 3

/**
 * Enough paragraphs to get past a heading, an epigraph and a short list, and no
 * more. The whole point of the limit is to avoid pulling three full chapters
 * over the wire to read two sentences from each.
 */
const PARAGRAPHS_FETCHED = 12

const SENTENCES_WANTED = 2

/**
 * A sentence long enough to be worth auditioning a voice on.
 *
 * The extracted text of a chapter usually opens with the chapter's own heading
 * -- "Chapter Nine", "Prologue", "PRELUDE TO THE STORMLIGHT ARCHIVE" -- which
 * tells you nothing about how the book will sound. All three checks earn their
 * place against real books: the word count rejects "Chapter Twenty-Seven", the
 * character count rejects a four-word title, and the punctuation check rejects
 * the long all-caps headings that pass both.
 */
const MIN_SENTENCE_WORDS = 5
const MIN_SENTENCE_CHARS = 25
const ENDS_A_SENTENCE = /[.!?]["'’”)\]]*$/

function isSubstantial(sentence: string): boolean {
  return sentence.length >= MIN_SENTENCE_CHARS
    && sentence.split(/\s+/).length >= MIN_SENTENCE_WORDS
    && ENDS_A_SENTENCE.test(sentence)
}

/**
 * The opening sentences of a chapter, skipping any leading fragments.
 *
 * Only *leading* fragments are skipped. Once real prose has started, a short
 * sentence is kept -- clipped, punchy lines are part of an author's rhythm, and
 * that rhythm is exactly what a narration sample should reveal.
 */
function openingSentences(paragraphs: string[]): string {
  const found: string[] = []
  for (const paragraph of paragraphs) {
    const matches = paragraph.match(/[^.!?]+[.!?]+["'’”)\]]*\s*/g) ?? [paragraph]
    for (const raw of matches) {
      const sentence = raw.trim()
      if (!sentence) continue
      if (!found.length && !isSubstantial(sentence)) continue
      found.push(sentence)
      if (found.length >= SENTENCES_WANTED) return found.join(' ')
    }
  }
  return found.join(' ')
}

/**
 * Passages from the first few chapters that will actually be narrated.
 *
 * Several chapters rather than one because books rarely open the way they
 * continue: chapter one is often scene-setting prose while chapter three is
 * mostly dialogue, and a voice can suit one and not the other.
 *
 * Fetched with useAsyncData rather than on mount so the passages are in the
 * server-rendered markup -- otherwise the dropdown briefly offers only the
 * stock phrases and then rearranges itself under the pointer.
 */
const { data: bookSamples } = await useAsyncData<Option[]>(
  'voice-sample-passages',
  async () => {
    if (!props.bookId) return []
    const book = await $fetch<BookDetail>(`/api/books/${props.bookId}`)
    const chapters = book.chapters.filter(c => c.include).slice(0, SAMPLE_CHAPTERS)

    const results = await Promise.all(chapters.map(async (chapter) => {
      try {
        const loaded = await $fetch<ChapterText>(
          `/api/books/${props.bookId}/chapters/${chapter.index}/text`,
          { query: { paragraphs: PARAGRAPHS_FETCHED } },
        )
        const passage = openingSentences(loaded.paragraphs)
        if (!passage) return null
        return {
          id: `chapter-${chapter.index}`,
          // Titles repeat across chapters often enough ("Chapter", numbered
          // headings) that the label alone cannot identify an option; the id
          // carries that job.
          label: `From "${chapter.title}"`,
          text: passage,
        }
      }
      catch {
        // One unreadable chapter should not cost the others their passage.
        return null
      }
    }))

    // A chapter that opens with a list rather than prose -- a table of
    // contents, an epigraph, a bulleted introduction -- yields nothing usable,
    // and is dropped rather than offered as an empty option.
    return results.filter((o): o is Option => o !== null)
  },
  { default: () => [], watch: [() => props.bookId] },
)

const options = computed<Option[]>(() => [...(bookSamples.value ?? []), ...PRESETS])

const selected = ref('')

function apply(id: string) {
  selected.value = id
  const match = options.value.find(o => o.id === id)
  if (match) text.value = match.text
}

/** Offer the book's own opening, but never overwrite something already typed. */
function applyDefault(samples: Option[] | null) {
  const first = samples?.[0]
  if (first && !text.value.trim()) apply(first.id)
}

// After mount, not during setup. Writing to a defineModel goes out as an emit,
// and on the server the parent never re-renders in response -- so applying the
// default during setup left the textarea empty in the server-rendered markup
// and filled on the client, which is precisely a hydration mismatch. The list
// of options is still server-rendered; only the initial selection waits.
onMounted(() => applyDefault(bookSamples.value))
watch(bookSamples, applyDefault)
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <select
        class="select select-bordered select-sm max-w-xs"
        :value="selected"
        aria-label="Sample phrase"
        @change="apply(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>
          Choose a sample phrase…
        </option>
        <optgroup v-if="bookSamples?.length" label="From this book">
          <option v-for="option in bookSamples" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </optgroup>
        <optgroup label="Test phrases">
          <option v-for="option in PRESETS" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </optgroup>
      </select>
      <button
        v-if="text"
        class="btn btn-ghost btn-xs"
        @click="text = ''; selected = ''"
      >
        Clear
      </button>
    </div>

    <textarea
      v-model="text"
      class="textarea textarea-bordered w-full text-sm"
      rows="3"
      placeholder="Or type anything you want to hear in this voice…"
    />
    <p class="text-base-content/40 text-xs">
      {{ text.length }} characters. Long passages take proportionally longer to
      preview.
    </p>
  </div>
</template>
