import { classifyBasis } from '../../utils/healthSync'

/**
 * "What the watch sent" (docs/samsung-health-sync.md §2.1, §7) — the last
 * ~20 sync payloads (health_sync_log trims to this itself), each classified
 * by the same cascade rule the sync route actually applies, so the tally
 * shown here can never drift from what really happened to the data. This is
 * the permanent replacement for a one-off "does Samsung send calories"
 * spike: the answer is here continuously, not asked once by hand.
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const rows = useDb()
    .prepare(
      `SELECT id, received_at, session_count, outcome, payload
       FROM health_sync_log WHERE user_id = ? ORDER BY id DESC LIMIT 20`,
    )
    .all(user.id) as {
    id: number
    received_at: string
    session_count: number
    outcome: string
    payload: string
  }[]

  const logs = rows.map((row) => {
    const basis = { device: 0, device_window: 0, estimated: 0 }
    try {
      const parsed = JSON.parse(row.payload) as {
        sessions?: { active_kcal?: number | null; active_kcal_basis?: unknown }[]
      }
      for (const session of parsed.sessions ?? []) {
        basis[classifyBasis(session.active_kcal, session.active_kcal_basis)]++
      }
    } catch {
      // The stored payload isn't valid JSON — a malformed request the server
      // rejected before ever parsing it. Nothing to tally; outcome already
      // says why.
    }

    return {
      id: row.id,
      received_at: row.received_at,
      session_count: row.session_count,
      outcome: row.outcome,
      basis,
    }
  })

  return { logs }
})
