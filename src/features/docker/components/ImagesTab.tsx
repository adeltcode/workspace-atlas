import { useState, useMemo } from 'react'
import { Pin, PinOff, X } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { DockerImage } from '../types'
import { SortHeader } from './TableBits'

type SortKey = 'name' | 'size_bytes' | 'age_days'
type SortDir = 'asc' | 'desc'

export default function ImagesTab({ images, loading }: { images: DockerImage[]; loading: boolean }) {
  const { dockerKeepList, addToKeepList, removeFromKeepList } = useAppStore()

  // Consume a pre-filter set by the overview cleanup panel (ephemeral, one-shot)
  const [imageFilter, setImageFilter] = useState<'dangling' | 'unused-tagged' | null>(() => {
    const s = useAppStore.getState()
    const f = s.imagesFilter
    if (f) { s.setImagesFilter(null); return f }
    return null
  })

  const [sortKey, setSortKey] = useState<SortKey>('size_bytes')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [maxAge, setMaxAge]   = useState(3650)
  const [search, setSearch]   = useState('')

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  const sorted = useMemo(() => {
    const q = search.toLowerCase()
    return [...images]
      .filter(img => {
        if (imageFilter === 'dangling')      return !img.in_use && img.repository === '<none>'
        if (imageFilter === 'unused-tagged') return !img.in_use && img.repository !== '<none>'
        return true
      })
      .filter(img => img.age_days <= maxAge)
      .filter(img => !q || img.repository.toLowerCase().includes(q) || img.tag.toLowerCase().includes(q) || img.id.includes(q))
      .sort((a, b) => {
        const av = sortKey === 'name' ? `${a.repository}:${a.tag}` : a[sortKey]
        const bv = sortKey === 'name' ? `${b.repository}:${b.tag}` : b[sortKey]
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [images, sortKey, sortDir, maxAge, search, imageFilter])

  const rows = [...sorted.filter(i => dockerKeepList.includes(i.id)), ...sorted.filter(i => !dockerKeepList.includes(i.id))]

  if (loading) return <div className="img-loading">Loading images…</div>
  if (!images.length) return <p className="empty-state">No images found.</p>

  return (
    <div className="img-tab">
      {imageFilter && (
        <div className="prefilter-banner">
          {imageFilter === 'dangling'
            ? 'Showing dangling (<none>:<none>) images only'
            : 'Showing unused tagged images only'}
          <button className="prefilter-banner-close" onClick={() => setImageFilter(null)} title="Clear filter">
            <X size={12} />
          </button>
        </div>
      )}
      <div className="img-toolbar">
        <input
          className="img-search"
          type="search"
          placeholder="Filter by name, tag, or ID…"
          aria-label="Filter images"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="age-filter">
          <span className="age-label">
            Age ≤ {maxAge >= 3650 ? 'any' : maxAge >= 365 ? `${Math.round(maxAge / 365)}y` : `${maxAge}d`}
          </span>
          <input type="range" min={1} max={3650} aria-label="Maximum image age in days" value={maxAge} onChange={e => setMaxAge(Number(e.target.value))} className="age-slider" />
        </div>
        <span className="img-count">{rows.length} image{rows.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <SortHeader label="Name : Tag" col="name"       sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="img-th">ID</th>
              <SortHeader label="Size"       col="size_bytes" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <SortHeader label="Age"        col="age_days"   sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
              <th className="img-th">Status</th>
              <th className="img-th img-th-pin">Pin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(img => {
              const pinned = dockerKeepList.includes(img.id)
              return (
                <tr key={`${img.id}-${img.repository}-${img.tag}`} className={clsx('img-row', pinned && 'pinned')}>
                  <td className="img-td img-name">
                    {pinned && <Pin size={10} className="row-pin-icon" />}
                    <span className="img-repo">{img.repository}</span>
                    <span className="img-colon">:</span>
                    <span className="img-tag">{img.tag}</span>
                  </td>
                  <td className="img-td img-id">{img.id}</td>
                  <td className="img-td img-size">{img.size}</td>
                  <td className="img-td img-age">{img.created_since}</td>
                  <td className="img-td">
                    {img.in_use
                      ? <span className="badge badge-active">In use</span>
                      : <span className="badge badge-idle">Unused</span>}
                  </td>
                  <td className="img-td img-td-pin">
                    <button
                      className={clsx('pin-btn', pinned && 'pinned')}
                      onClick={() => pinned ? removeFromKeepList(img.id) : addToKeepList(img.id)}
                      title={pinned ? 'Unpin from keep-list' : 'Pin - never prune this image'}
                    >
                      {pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {dockerKeepList.length > 0 && (
        <div className="keeplist-notice">
          <Pin size={12} />
          {dockerKeepList.length} image{dockerKeepList.length !== 1 ? 's' : ''} pinned - never pruned
        </div>
      )}
    </div>
  )
}
