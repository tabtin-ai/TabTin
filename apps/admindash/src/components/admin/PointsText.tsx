export function PointsText({ value }: { value: number | string }) {
  const numeric = typeof value === 'number' ? value : Number(value || 0)
  return <span>{numeric.toLocaleString()} 点</span>
}
