export type SortDir = 'asc' | 'desc'

export const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })

/** Unknown values sort last in both directions, and `tie` orders rows that compare equal. */
export function sortRows<T>(
  rows: T[],
  valueOf: (row: T) => string | number | null,
  tie: (a: T, b: T) => number,
  dir: SortDir,
): T[] {
  return [...rows].sort((a, b) => {
    const va = valueOf(a), vb = valueOf(b)
    if (va === null || vb === null) return va === vb ? tie(a, b) : va === null ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : compareText(String(va), String(vb))
    return (dir === 'asc' ? cmp : -cmp) || tie(a, b)
  })
}
