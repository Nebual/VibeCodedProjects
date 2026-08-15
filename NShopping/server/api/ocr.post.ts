import { createError } from 'h3'

// The OCR model runs as a resident llama-server (Qwen2.5-VL) in a docker-compose
// container on the same box — see docker-compose.yml. We proxy through the app server
// rather than calling it from the browser so the GPU box is never exposed and there's
// no CORS surface; the browser only ever talks to this Nuxt origin.
const OCR_SERVER_URL = (process.env.OCR_SERVER_URL ?? 'http://localhost:8191').replace(/\/+$/, '')
// llama-server ignores the model name, but the OpenAI-shaped payload wants the field.
const OCR_MODEL = process.env.OCR_MODEL ?? 'Qwen2.5-VL-3B-Instruct'
// A photo of a list transcribes to well under this; it only caps a runaway generation.
const MAX_TOKENS = 256
// The RX 580 answers in ~5s; allow generous headroom (cold cache, a busier box) before failing.
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 60_000)
// The client resizes to ~768px before upload, so a real payload is well under a megabyte.
// This just rejects obviously-wrong bodies early. Data URLs are ~1.37x the raw bytes.
const MAX_IMAGE_CHARS = 8 * 1024 * 1024

// "no bullet characters" is about the marker that opens a line. A "+" or "-" written
// *between* two words is not decoration — it is how people run two items onto one line,
// and splitBulkInput relies on it surviving, so the prompt asks for it back explicitly.
const PROMPT = 'OCR this image. Transcribe every line of handwritten and printed text '
  + 'exactly as written, one item per line. Do not open a line with a bullet character. '
  + 'Keep any "+" or "-" that appears between words, exactly where it is. '
  + 'Output only the transcription, with no commentary.'

interface ChatCompletion {
  choices?: { message?: { content?: string } }[]
}

export default defineEventHandler(async (event): Promise<{ text: string }> => {
  const body = await readBody<{ image?: unknown }>(event)
  const image = body?.image

  if (typeof image !== 'string' || !image.startsWith('data:image/')) {
    throw createError({ statusCode: 400, statusMessage: 'Expected an image data URL' })
  }
  if (image.length > MAX_IMAGE_CHARS) {
    throw createError({ statusCode: 413, statusMessage: 'Image too large' })
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)

  let completion: ChatCompletion
  try {
    completion = await $fetch<ChatCompletion>(`${OCR_SERVER_URL}/v1/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      body: {
        model: OCR_MODEL,
        temperature: 0,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: image } },
          ],
        }],
      },
    })
  }
  catch {
    const timedOut = controller.signal.aborted
    throw createError({
      statusCode: timedOut ? 504 : 502,
      statusMessage: timedOut ? 'OCR timed out' : 'OCR server unreachable',
      message: timedOut
        ? 'The OCR server took too long to respond.'
        : `Could not reach the OCR server at ${OCR_SERVER_URL}. Is the llama-server container running?`,
    })
  }
  finally {
    clearTimeout(timer)
  }

  const text = (completion.choices?.[0]?.message?.content ?? '').trim()
  return { text }
})
