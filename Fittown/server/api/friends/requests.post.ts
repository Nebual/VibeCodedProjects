import { findUserByEmail, requestFriendship } from '../../utils/friends'

/**
 * Ask someone to be your friend, by the address they sign in with.
 *
 * Nothing happens to their data until they accept: the row is created
 * `pending` and the prompt in their layout picks it up.
 *
 * An address nobody has signed up with is a 404 that points at the other route
 * into this feature — an invite link works before the person has an account,
 * which is exactly the case this one can't cover.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody<Record<string, unknown>>(event)

  const email = assertText(body.email, 'email', 200).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: 'That doesn’t look like an email address' })
  }

  if (email === user.email.toLowerCase()) {
    throw createError({ statusCode: 400, statusMessage: 'That’s your own address' })
  }

  const db = useDb()
  const target = findUserByEmail(db, email)
  if (!target) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Nobody signs in with that address. Send them an invite link instead.',
    })
  }

  const result = transact((conn) => requestFriendship(conn, user.id, target.id))

  return { status: result.status, user: target }
})
