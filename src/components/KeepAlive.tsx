import { Activity, useRef, type ReactNode } from 'react'

/** Renders `children` the first time `active` is true, then keeps them while hidden. State and rows
 *  stay. Effects stop while hidden and run again when shown, so timers pause and data can refresh. */
export default function KeepAlive({ active, children }: { active: boolean; children: ReactNode }) {
  const shown = useRef(false)
  if (active) shown.current = true
  if (!shown.current) return null
  return <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>
}
