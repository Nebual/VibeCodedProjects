/**
 * Arms the store to accept minimums/maximums from the next external report,
 * discarding the "this server owns them" state set by earlier reports and edits.
 */
export default defineEventHandler(() => resetTargetSeeding())
