import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * Minimal RFC4180 CSV parser.
 *
 * USDA's FoodData Central exports are real quoted CSV (values like
 * `"HUMMUS, SABRA CLASSIC"` embed commas), unlike Open Food Facts' TSV dump
 * which only needed `split('\t')`. Shared so the Foundation Foods and
 * Branded Foods importers parse the same way.
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += c
        i++
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      i++
    } else if (c === ',') {
      row.push(field)
      field = ''
      i++
    } else if (c === '\r') {
      i++
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else {
      field += c
      i++
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Stream a CSV file as header-keyed row objects, one line at a time.
 *
 * `readFileSync` + `parseCsvRecords` is fine for Foundation Foods' few-MB
 * files, but Branded Foods' are hundreds of MB to low-GB — too large (and in
 * `food_nutrient.csv`'s case, past Node's comfortable single-string limit)
 * to read whole. This is only safe when no field contains an embedded
 * newline, since it treats one text line as one record — verified for the
 * specific files it's used on (`wc -l` matches a full quote-aware parse) by
 * whoever adds a new file here, not guaranteed in general for arbitrary CSV.
 */
export async function* streamCsvRecords(path) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let header = null
  for await (const line of rl) {
    if (line === '') continue
    const fields = parseCsv(line)[0] ?? []
    if (header === null) {
      header = fields
      continue
    }
    const record = {}
    for (let i = 0; i < header.length; i++) record[header[i]] = fields[i] ?? ''
    yield record
  }
}

/** Parse a CSV file's text into an array of header-keyed objects. */
export function parseCsvRecords(text) {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0]
  const records = []
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (row.length === 1 && row[0] === '') continue // trailing blank line
    const record = {}
    for (let c = 0; c < header.length; c++) record[header[c]] = row[c] ?? ''
    records.push(record)
  }
  return records
}
