import { LabelOcrError, transcribeLabelImage } from '../../utils/labelOcr'

/**
 * Scan a Nutrition Facts label photo and return the nutrients it states, so
 * the "new food" form can prefill itself.
 *
 * The photo goes to the same locally-run vision model and configuration as the
 * recipe scanner (`utils/recipeOcr.ts`): no third party sees the image, and
 * there is no per-request cost. Nothing is stored here — the client decides
 * what to prefill and then saves through the ordinary POST /api/foods path.
 */

/** A client-resized JPEG easily fits under this; guards against a raw phone photo. */
const MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024

export default defineEventHandler(async (event) => {
  await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const { baseUrl, model } = useRuntimeConfig().recipeOcr
  if (!baseUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Photo scanning isn’t set up on this server',
    })
  }

  // Checked by hand rather than with `assertText`: that helper truncates
  // oversized input, which would hand a corrupt half-image to the model.
  if (typeof body.image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(body.image)) {
    throw createError({ statusCode: 400, statusMessage: 'image must be a JPEG, PNG or WebP data URL' })
  }
  if (body.image.length > MAX_IMAGE_DATA_URL_CHARS) {
    throw createError({ statusCode: 400, statusMessage: 'That photo is too large' })
  }

  let result
  try {
    result = await transcribeLabelImage(body.image, baseUrl, model)
  } catch (err) {
    if (err instanceof LabelOcrError) {
      throw createError({ statusCode: 422, statusMessage: err.message })
    }
    throw err
  }

  return result
})
