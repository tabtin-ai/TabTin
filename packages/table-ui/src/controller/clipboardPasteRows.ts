export function parseTsvText(text: string): string[][] {
  if (!text) return []

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += ch
        i++
      }
    } else if (ch === '"') {
      inQuotes = true
      i++
    } else if (ch === '\t') {
      row.push(field)
      field = ''
      i++
    } else if (ch === '\r') {
      i++
    } else if (ch === '\n') {
      row.push(field)
      field = ''
      rows.push(row)
      row = []
      i++
    } else {
      field += ch
      i++
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows.filter(
    (candidate) => candidate.length > 0 && candidate.some((cell) => cell !== ''),
  )
}

function parseMarkdownTable(text: string): string[][] | null {
  const lines = text.trim().split('\n').map((line) => line.trim())
  if (lines.length < 2) return null

  const separatorIndex = lines.findIndex((line) =>
    /^\|?[\s\-:|]+\|[\s\-:|]*\|?$/.test(line),
  )
  if (separatorIndex < 0) return null

  const rows = lines
    .filter((_, index) => index !== separatorIndex)
    .map((line) => {
      const trimmed = line.replace(/^\||\|$/g, '')
      return trimmed.split('|').map((cell) => cell.trim())
    })

  if (rows.length === 0 || rows[0].length < 2) return null
  return rows
}

function parseHtmlTable(html: string): string[][] | null {
  if (!html) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return null

  const rows: string[][] = []
  table.querySelectorAll('tr').forEach((tr) => {
    const cells: string[] = []
    tr.querySelectorAll('td, th').forEach((cell) => {
      cells.push((cell.textContent ?? '').trim())
    })
    if (cells.length > 0) rows.push(cells)
  })

  return rows.length > 0 ? rows : null
}

export function resolveClipboardPasteRows(
  text: string,
  html: string,
  anchorFieldType?: string,
): string[][] {
  let parsedRows = parseTsvText(text).filter((row) =>
    row.some((cell) => cell !== ''),
  )
  const markdownRows = parseMarkdownTable(text)
  const htmlRows = parseHtmlTable(html)
  const isLongTextTarget = anchorFieldType === 'long_text' || anchorFieldType === 'longtext'

  if (
    isLongTextTarget &&
    /[\r\n]/.test(text) &&
    parsedRows.every((row) => row.length <= 1) &&
    !text.includes('\t') &&
    !markdownRows &&
    !htmlRows
  ) {
    return [[text.replace(/\r\n?/g, '\n')]]
  }

  if (parsedRows.length > 0 && parsedRows.every((row) => row.length <= 1)) {
    if (markdownRows && markdownRows.length > 0 && markdownRows[0].length > 1) {
      parsedRows = markdownRows
    }
  }

  if (parsedRows.length > 0 && parsedRows.every((row) => row.length <= 1)) {
    if (htmlRows && htmlRows.length > 0) {
      parsedRows = htmlRows
    }
  }

  return parsedRows
}
