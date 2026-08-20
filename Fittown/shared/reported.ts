/**
 * "Report as inaccurate" rules, shared by the button and the hide filter.
 *
 * One file so the page (whether to offer Report/Undo), the search, Frequent and
 * the detail route (whether to show this food at all) and the report/unreport
 * routes (whether the action is legal) all answer the same two questions the
 * same way. A divergence here is a leak or a food the owner can't see, so it is
 * kept pure and unit-tested.
 */

/** A food's identity as far as reporting is concerned. */
export interface ReportableFood {
  source: string
  owner_user_id: number | null
  /**
   * Who already reported it, if anyone. Absent (null) on a row that predates
   * the column and on anything never flagged.
   */
  reported_by?: number | null
}

/**
 * May `viewer` report this food?
 *
 * A lab-analysed USDA Foundation Food is presumed accurate (it is the named
 * reference data; reporting it off the shelf hides a whole product for the
 * household). A custom food is only reportable by someone *other* than its
 * owner — you cannot flag your own entry.
 */
export function canReportFood(food: ReportableFood, viewerId: number): boolean {
  if (food.source === 'usda_foundation') return false
  if (food.source === 'custom' && food.owner_user_id === viewerId) return false
  return true
}

/**
 * Should `viewer` be shown this food at all?
 *
 * A reported food is hidden from everyone except its owner. The owner exemption
 * is deliberately only for `custom` foods (a reported OFF product has no owner
 * to run back to). This is the predicate every list and the detail route use
 * to decide whether a row is worth returning.
 */
export function reportedFoodHidden(
  food: ReportableFood & { reported_by?: number | null },
  viewerId: number,
): boolean {
  if (food.reported_by == null) return false
  if (food.source === 'custom' && food.owner_user_id === viewerId) return false
  return true
}