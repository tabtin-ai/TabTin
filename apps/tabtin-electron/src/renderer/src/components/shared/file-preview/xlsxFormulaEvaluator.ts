/**
 * A deliberately small, safe Excel formula evaluator for read-only previews.
 *
 * It never executes JavaScript and intentionally supports only deterministic,
 * same-sheet formulas. Full Excel compatibility belongs to a spreadsheet app,
 * not a file preview.
 */

export type FormulaScalar = string | number | boolean | Date | null

export type FormulaEvaluation =
  | { ok: true; value: FormulaScalar }
  | { ok: false }

export const XLSX_FORMULA_MAX_INPUT_LENGTH = 4_096
export const XLSX_FORMULA_MAX_TOKENS = 512

type FormulaValue = FormulaScalar | FormulaScalar[]
type FormulaResult =
  | { ok: true; value: FormulaValue }
  | { ok: false }

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'cell'; value: string }
  | { type: 'name'; value: string }
  | { type: 'operator'; value: string }
  | { type: 'leftParen' | 'rightParen' | 'separator' | 'colon' | 'eof' }

const ok = (value: FormulaValue): FormulaResult => ({ ok: true, value })
const failed = (): FormulaResult => ({ ok: false })

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = []
  let index = 0

  while (index < input.length) {
    const char = input[index]
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (char === '"') {
      let value = ''
      index++
      let closed = false
      while (index < input.length) {
        if (input[index] === '"') {
          if (input[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index++
          closed = true
          break
        }
        value += input[index++]
      }
      if (!closed) return null
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'string', value })
      continue
    }
    const number = input.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/)
    if (number) {
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'number', value: Number(number[0]) })
      index += number[0].length
      continue
    }
    const cell = input.slice(index).match(/^\$?[A-Za-z]{1,3}\$?\d+/)
    if (cell) {
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'cell', value: cell[0].replace(/\$/g, '').toUpperCase() })
      index += cell[0].length
      continue
    }
    const name = input.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.]*/)
    if (name) {
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'name', value: name[0].toUpperCase() })
      index += name[0].length
      continue
    }
    const twoCharacterOperator = input.slice(index, index + 2)
    if (['<=', '>=', '<>'].includes(twoCharacterOperator)) {
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'operator', value: twoCharacterOperator })
      index += 2
      continue
    }
    if ('+-*/^&=<>'.includes(char)) {
      if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
      tokens.push({ type: 'operator', value: char })
      index++
      continue
    }
    if (tokens.length >= XLSX_FORMULA_MAX_TOKENS) return null
    if (char === '(') tokens.push({ type: 'leftParen' })
    else if (char === ')') tokens.push({ type: 'rightParen' })
    else if (char === ',' || char === ';') tokens.push({ type: 'separator' })
    else if (char === ':') tokens.push({ type: 'colon' })
    else return null
    index++
  }

  tokens.push({ type: 'eof' })
  return tokens
}

function flatten(value: FormulaValue): FormulaScalar[] {
  return Array.isArray(value) ? value.flatMap(flatten) : [value]
}

function scalar(value: FormulaValue): FormulaScalar | null {
  return Array.isArray(value) ? null : value
}

function numberValue(value: FormulaScalar): number | null {
  if (value == null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

function comparableValue(value: FormulaScalar): string | number | boolean | null {
  if (value instanceof Date) return value.getTime()
  return value
}

function truthy(value: FormulaScalar): boolean | null {
  if (typeof value === 'boolean') return value
  const numeric = numberValue(value)
  if (numeric != null) return numeric !== 0
  return null
}

function columnNumber(column: string): number {
  return [...column].reduce((result, char) => result * 26 + char.charCodeAt(0) - 64, 0)
}

function columnLabel(column: number): string {
  let label = ''
  while (column > 0) {
    column--
    label = String.fromCharCode(65 + (column % 26)) + label
    column = Math.floor(column / 26)
  }
  return label
}

function parseCellReference(reference: string): { column: number; row: number } | null {
  const match = /^([A-Z]{1,3})(\d+)$/.exec(reference)
  if (!match) return null
  return { column: columnNumber(match[1]), row: Number(match[2]) }
}

function roundExcel(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * factor) / factor
}

class FormulaParser {
  private index = 0

  constructor(
    private readonly tokens: Token[],
    private readonly readCell: (reference: string) => FormulaEvaluation,
  ) {}

  parse(): FormulaEvaluation {
    const result = this.parseComparison()
    if (this.current.type !== 'eof' || !result.ok) return { ok: false }
    const value = scalar(result.value)
    return value == null && Array.isArray(result.value) ? { ok: false } : { ok: true, value }
  }

  private get current(): Token {
    return this.tokens[this.index] ?? { type: 'eof' }
  }

  private consume(type: Token['type'], value?: string): boolean {
    if (this.current.type !== type || (value !== undefined && 'value' in this.current && this.current.value !== value)) {
      return false
    }
    this.index++
    return true
  }

  private parseComparison(): FormulaResult {
    let left = this.parseConcat()
    while (this.current.type === 'operator' && ['=', '<>', '<', '>', '<=', '>='].includes(this.current.value)) {
      const operator = this.current.value
      this.index++
      const right = this.parseConcat()
      if (!left.ok || !right.ok) return failed()
      const a = comparableValue(scalar(left.value) as FormulaScalar)
      const b = comparableValue(scalar(right.value) as FormulaScalar)
      if (a == null || b == null) return failed()
      left = ok(operator === '=' ? a === b : operator === '<>' ? a !== b : operator === '<' ? a < b : operator === '>' ? a > b : operator === '<=' ? a <= b : a >= b)
    }
    return left
  }

  private parseConcat(): FormulaResult {
    let left = this.parseAdditive()
    while (this.current.type === 'operator' && this.current.value === '&') {
      this.index++
      const right = this.parseAdditive()
      if (!left.ok || !right.ok) return failed()
      const a = scalar(left.value)
      const b = scalar(right.value)
      if (a == null || b == null) return failed()
      left = ok(`${a ?? ''}${b ?? ''}`)
    }
    return left
  }

  private parseAdditive(): FormulaResult {
    let left = this.parseMultiplicative()
    while (this.current.type === 'operator' && (this.current.value === '+' || this.current.value === '-')) {
      const operator = this.current.value
      this.index++
      const right = this.parseMultiplicative()
      if (!left.ok || !right.ok) return failed()
      const a = numberValue(scalar(left.value) as FormulaScalar)
      const b = numberValue(scalar(right.value) as FormulaScalar)
      if (a == null || b == null) return failed()
      left = ok(operator === '+' ? a + b : a - b)
    }
    return left
  }

  private parseMultiplicative(): FormulaResult {
    let left = this.parsePower()
    while (this.current.type === 'operator' && ['*', '/'].includes(this.current.value)) {
      const operator = this.current.value
      this.index++
      const right = this.parsePower()
      if (!left.ok || !right.ok) return failed()
      const a = numberValue(scalar(left.value) as FormulaScalar)
      const b = numberValue(scalar(right.value) as FormulaScalar)
      if (a == null || b == null || (operator === '/' && b === 0)) return failed()
      left = ok(operator === '*' ? a * b : a / b)
    }
    return left
  }

  private parsePower(): FormulaResult {
    let left = this.parseUnary()
    while (this.current.type === 'operator' && this.current.value === '^') {
      this.index++
      const right = this.parseUnary()
      if (!left.ok || !right.ok) return failed()
      const a = numberValue(scalar(left.value) as FormulaScalar)
      const b = numberValue(scalar(right.value) as FormulaScalar)
      if (a == null || b == null) return failed()
      left = ok(a ** b)
    }
    return left
  }

  private parseUnary(): FormulaResult {
    if (this.current.type === 'operator' && (this.current.value === '+' || this.current.value === '-')) {
      const operator = this.current.value
      this.index++
      const value = this.parseUnary()
      if (!value.ok) return failed()
      const number = numberValue(scalar(value.value) as FormulaScalar)
      return number == null ? failed() : ok(operator === '-' ? -number : number)
    }
    return this.parsePrimary()
  }

  private parsePrimary(): FormulaResult {
    if (this.current.type === 'number' || this.current.type === 'string') {
      const value = this.current.value
      this.index++
      return ok(value)
    }
    if (this.current.type === 'cell') {
      const start = this.current.value
      this.index++
      if (this.consume('colon')) {
        if (this.current.type !== 'cell') return failed()
        const end = this.current.value
        this.index++
        return this.readRange(start, end)
      }
      return this.readCell(start)
    }
    if (this.current.type === 'name') {
      const name = this.current.value
      this.index++
      if (name === 'TRUE') return ok(true)
      if (name === 'FALSE') return ok(false)
      if (!this.consume('leftParen')) return failed()
      const args: FormulaResult[] = []
      if (!this.consume('rightParen')) {
        do {
          args.push(this.parseComparison())
        } while (this.consume('separator'))
        if (!this.consume('rightParen')) return failed()
      }
      return this.callFunction(name, args)
    }
    if (this.consume('leftParen')) {
      const value = this.parseComparison()
      return this.consume('rightParen') ? value : failed()
    }
    return failed()
  }

  private readRange(start: string, end: string): FormulaResult {
    const startCell = parseCellReference(start)
    const endCell = parseCellReference(end)
    if (!startCell || !endCell) return failed()
    const cellCount = (Math.abs(endCell.column - startCell.column) + 1) * (Math.abs(endCell.row - startCell.row) + 1)
    if (cellCount > 10_000) return failed()
    const values: FormulaScalar[] = []
    for (let row = Math.min(startCell.row, endCell.row); row <= Math.max(startCell.row, endCell.row); row++) {
      for (let column = Math.min(startCell.column, endCell.column); column <= Math.max(startCell.column, endCell.column); column++) {
        const result = this.readCell(`${columnLabel(column)}${row}`)
        if (!result.ok) return failed()
        values.push(result.value)
      }
    }
    return ok(values)
  }

  private callFunction(name: string, args: FormulaResult[]): FormulaResult {
    if (name === 'IFERROR') return args.length === 2 ? (args[0].ok ? args[0] : args[1]) : failed()
    if (name === 'IF') {
      if (args.length < 2 || args.length > 3 || !args[0].ok) return failed()
      const condition = truthy(scalar(args[0].value) as FormulaScalar)
      if (condition == null) return failed()
      return condition ? args[1] : (args[2] ?? ok(false))
    }
    if (args.some(arg => !arg.ok)) return failed()
    const values = args.flatMap(arg => flatten((arg as { ok: true; value: FormulaValue }).value))
    const numericValues = values.map(numberValue).filter((value): value is number => value != null)

    switch (name) {
      case 'SUM': return ok(numericValues.reduce((sum, value) => sum + value, 0))
      case 'MIN': return numericValues.length ? ok(Math.min(...numericValues)) : ok(0)
      case 'MAX': return numericValues.length ? ok(Math.max(...numericValues)) : ok(0)
      case 'AVERAGE': return numericValues.length ? ok(numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length) : failed()
      case 'COUNT': return ok(values.filter(value => typeof value === 'number' && Number.isFinite(value)).length)
      case 'COUNTA': return ok(values.filter(value => value != null && value !== '').length)
      case 'ABS': return numericValues.length === 1 ? ok(Math.abs(numericValues[0])) : failed()
      case 'INT': return numericValues.length === 1 ? ok(Math.floor(numericValues[0])) : failed()
      case 'MOD': return numericValues.length === 2 && numericValues[1] !== 0 ? ok(numericValues[0] % numericValues[1]) : failed()
      case 'POWER': return numericValues.length === 2 ? ok(numericValues[0] ** numericValues[1]) : failed()
      case 'ROUND': return numericValues.length === 2 ? ok(roundExcel(numericValues[0], numericValues[1])) : failed()
      case 'ROUNDUP': return numericValues.length === 2 ? ok(Math.sign(numericValues[0]) * Math.ceil(Math.abs(numericValues[0]) * 10 ** numericValues[1]) / 10 ** numericValues[1]) : failed()
      case 'ROUNDDOWN': return numericValues.length === 2 ? ok(Math.sign(numericValues[0]) * Math.floor(Math.abs(numericValues[0]) * 10 ** numericValues[1]) / 10 ** numericValues[1]) : failed()
      case 'AND': return values.every(value => truthy(value) === true) ? ok(true) : ok(false)
      case 'OR': return values.some(value => truthy(value) === true) ? ok(true) : ok(false)
      case 'NOT': {
        const value = values.length === 1 ? truthy(values[0]) : null
        return value == null ? failed() : ok(!value)
      }
      case 'CONCATENATE': return ok(values.map(value => value ?? '').join(''))
      default: return failed()
    }
  }
}

export function evaluateXlsxFormula(
  formula: string,
  readCell: (reference: string) => FormulaEvaluation,
): FormulaEvaluation {
  const expression = formula.replace(/^=/, '')
  if (expression.length > XLSX_FORMULA_MAX_INPUT_LENGTH) return { ok: false }
  const tokens = tokenize(expression)
  if (!tokens) return { ok: false }
  return new FormulaParser(tokens, readCell).parse()
}
