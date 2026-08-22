import { describe, expect, it } from 'vitest'
import { evaluateXlsxFormula, type FormulaEvaluation } from '../xlsxFormulaEvaluator'

describe('xlsxFormulaEvaluator', () => {
  it('calculates the bounded same-sheet formulas used by a calculator preview', () => {
    const formulas = new Map([
      ['B2', 'MIN(MAX(A2,7384),36921)'],
      ['C2', 'ROUND(B2*0.08,2)'],
      ['G2', 'SUM(C2:F2)'],
    ])
    const values = new Map<string, number>([
      ['A2', 6000],
      ['D2', 147.68],
      ['E2', 36.92],
      ['F2', 516.88],
    ])
    const resolve = (reference: string): FormulaEvaluation => {
      const formula = formulas.get(reference)
      if (formula) {
        const result = evaluateXlsxFormula(formula, resolve)
        if (result.ok && typeof result.value === 'number') values.set(reference, result.value)
        return result
      }
      return { ok: true, value: values.get(reference) ?? null }
    }

    expect(resolve('B2')).toEqual({ ok: true, value: 7384 })
    expect(resolve('C2')).toEqual({ ok: true, value: 590.72 })
    expect(resolve('G2')).toEqual({ ok: true, value: 1292.2 })
  })

  it('refuses formulas that cross the safe preview boundary', () => {
    expect(evaluateXlsxFormula("'Rate Sheet'!A1*0.08", () => ({ ok: true, value: 1 }))).toEqual({ ok: false })
  })
})
