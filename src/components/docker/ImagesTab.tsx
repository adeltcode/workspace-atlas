import { useState, useMemo } from 'react'
import { Pin, PinOff, ChevronUp, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../store/appStore'
import type { DockerImage } from '../../types/docker'

type SortKey = 'name' | 'size_bytes' | 'age_days'
type SortDir = 'asc' | 'desc'

function SortHeader({
  label, sortKey, active, dir, onSort,
}: {
  label: string; sortKey: SortKey; active: SortKey; dir: SortDir
  onSort: (k: SortKey) => void
}) {
  const isActive = sortKey === active
  return (
    <th className={clsx('img-th sortable', isActive && 'active')} onClick={() => onSort(sortKey)}>
      <span>{label}</span>
      {isActive
        ? dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />
        : <ChevronDown size={12} className="sort-idle" />}
    </th>
  )
}

export default function ImagesTab({
  images,
  loading,
}: {
  images: DockerImage[]
  loading: boolean
}) {
  const { dockerKeepList, addToKeepList, removeFromKeepList } = useAppStore()

  const [sortKey, setSortKey] = useState<SortKey>('size_bytes')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [maxAge, setMaxAge] = useState<number>(3650)
  const [search, setSearch] = useState('')

  const handleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = useMemo(() => {
    const q = search.toLowerCase()
    return [...images]
      .filter((img) => img.age_days <= maxAge)
      .filter((img) => {
        if (!q) return true
        return (
          img.repository.toLowerCase().includes(q) ||
          img.tag.toLowerCase().includes(q) ||
          img.id.includes(q)
        )
      })
      .sort((a, b) => {
        let av: string | number, bv: string | number
        if (sortKey === 'name') {
          av = `${a.repository}:${a.tag}`
          bv = `${b.repository}:${b.tag}`
        } else {
          av = a[sortKey]
          bv = b[sortKey]
        }
        const cmp = av < bv ? -1 : av > bv ? 1 : 0
        return sortDir === 'asc' ? cmp : -cmp
      })
  }, [images, sortKey, sortDir, maxAge, search])

  const pinned = sorted.filter((i) => dockerKeepList.includes(i.id))
  const unpinned = sorted.filter((i) => !dockerKeepList.includes(i.id))
  const rows = [...pinned, ...unpinned]

  if (loading) {
    return <div className="img-loading">Loading images…</div>
  }

  if (!images.length) {
    return <p className="empty-state">No images found.</p>
  }

  return (
    <div className="img-tab">
      {/* Toolbar */}
      <div className="img-toolbar">
        <input
          className="img-search"
          type="search"
          placeholder="Filter by name, tag, or ID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="age-filter">
          <span className="age-label">Age ≤ {maxAge >= 3650 ? 'any' : maxAge >= 365 ? `${Math.round(maxAge / 365)}y` : `${maxAge}d`}</span>
          <input
            type="range"
            min={1}
            max={3650}
            value={maxAge}
            onChange={(e) => setMaxAge(Number(e.target.value))}
            className="age-slider"
          />
        </div>
        <span className="img-count">{rows.length} image{rows.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="img-table-wrap">
        <table className="img-table">
          <thead>
            <tr>
              <SortHeader label="Name : Tag" sortKey="name"      active={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="img-th">ID</th>
              <SortHeader label="Size"       sortKey="size_bytes" active={sortKey} dir={sortDir} onSort={handleSort} />
              <SortHeader label="Age"        sortKey="age_days"   active={sortKey} dir={sortDir} onSort={handleSort} />
              <th className="img-th">Status</th>
              <th className="img-th img-th-pin">Pin</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((img) => {
              const pinned = dockerKeepList.includes(img.id)
              const rowKey = `${img.id}-${img.repository}-${img.tag}`
              return (
                <tr key={rowKey} className={clsx('img-row', pinned && 'pinned')}>
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
                    {img.in_use ? (
                      <span className="badge badge-active">In use</span>
                    ) : (
                      <span className="badge badge-idle">Unused</span>
                    )}
                  </td>
                  <td className="img-td img-td-pin">
                    <button
                      className={clsx('pin-btn', pinned && 'pinned')}
                      onClick={() => pinned ? removeFromKeepList(img.id) : addToKeepList(img.id)}
                      title={pinned ? 'Unpin from keep-list' : 'Pin — never prune this image'}
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
          {dockerKeepList.length} image{dockerKeepList.length !== 1 ? 's' : ''} pinned — never pruned
        </div>
      )}
    </div>
  )
}
