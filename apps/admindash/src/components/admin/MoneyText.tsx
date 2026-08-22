export function MoneyText({ value, decimals = 2 }: { value: number | string; decimals?: number }) {
  const numeric = typeof value === 'number' ? value : Number(value || 0)
  return <span>¥{numeric.toFixed(decimals)}</span>
}
