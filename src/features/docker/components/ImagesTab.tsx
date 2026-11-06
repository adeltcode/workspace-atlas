import { Fragment, useState, useMemo } from 'react'
import { Pin, PinOff, Layers } from 'lucide-react'
import clsx from 'clsx'
import { useAppStore } from '../../../store/appStore'
import type { DockerContainer, DockerImage } from '../types'
import { StatusCell, useDockerJump, useDockerTable } from './TableBits'
import { Button, CellLink, EmptyState, SearchField, Segmented, SegmentedItem, Toolbar } from '../../../components/ui'
import { TableHead } from '../../../components/TableColumns'
import {
  containersUsing, filterImages, imageName, matchesImageFilter, sortImages,
  type ImageFilter, type ImageSortKey, type SortDir,
} from '../rules'

const FILTERS: { key: ImageFilter; label: string; title?: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'in-use', label: 'In use' },
  { key: 'unused', label: 'Unused', title: 'Tagged images not used by any container' },
  { key: 'dangling', label: 'Dangling', title: 'Untagged images not used by any container' },
  { key: 'pinned', label: 'Pinned', title: 'Pinned images are never pruned' },
]

const Dash = () => <span className="pkg-dash">-</span>

export default function ImagesTab({ images, containers, loading }: { images: DockerImage[]; containers: DockerContainer[]; loading: boolean }) {
  const { dockerKeepList, addToKeepList, removeFromKeepList } = useAppStore()
  const table = useDockerTable<ImageSortKey>('images')

  // Consumes a one-shot pre-filter set by the Overview cleanup panel.
  const [filter, setFilter] = useState<ImageFilter>(() => {
    const s = useAppStore.getState()
    const f = s.imagesFilter
    if (f) s.setImagesFilter(null)
    return f === 'dangling' ? 'dangling' : f === 'unused-tagged' ? 'unused' : 'all'
  })

  const [sortKey, setSortKey] = useState<ImageSortKey>('size')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [search, setSearch]   = useState('')

  useDockerJump('images', ({ query }) => {
    setSearch(query)
    setFilter('all')
  })

  const handleSort = (key: ImageSortKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'size' || key === 'created' ? 'desc' : 'asc') }
  }

  const rows = useMemo(() => {
    const sorted = sortImages(filterImages(images, search, filter, dockerKeepList), sortKey, sortDir)
    return [...sorted.filter(i => dockerKeepList.includes(i.id)), ...sorted.filter(i => !dockerKeepList.includes(i.id))]
  }, [images, search, filter, dockerKeepList, sortKey, sortDir])

  if (loading) return <div className="img-loading">Loading images…</div>
  if (!images.length) return (
    <EmptyState
      icon={Layers}
      title="No images on this engine"
      description="No images have been pulled or built. Run docker pull or start a Compose project."
    />
  )

  const cell = (column: string, image: DockerImage) => {
    const pinned = dockerKeepList.includes(image.id)
    switch (column) {
      case 'name':
        return (
          <td className="img-td img-name" title={imageName(image)}>
            {pinned && <Pin size={10} className="row-pin-icon" />}
            <span className="img-repo">{image.repository}</span>
            {image.repository !== '<none>' && <><span className="img-colon">:</span><span className="img-tag">{image.tag}</span></>}
          </td>
        )
      case 'id':
        return <td className="img-td img-id" title={image.id}>{image.id.replace(/^sha256:/, '').slice(0, 12)}</td>
      case 'size':
        return <td className="img-td img-size">{image.size}</td>
      case 'created':
        return <td className="img-td img-age">{image.created_since}</td>
      case 'status':
        return <td className="img-td img-age"><StatusCell dot={image.in_use ? 'running' : 'stopped'}>{image.in_use ? 'In use' : 'Unused'}</StatusCell></td>
      case 'used-by': {
        const users = containersUsing(image, containers)
        return (
          <td className="img-td img-age" title={users.map(c => c.name).join(', ')}>
            {users.length === 0 && <Dash />}
            {users.map((c, i) => (
              <Fragment key={c.id}>
                {i > 0 && ', '}
                <CellLink title={`Show ${c.name} in Containers`} onClick={() => useAppStore.getState().jumpToDocker('containers', c.name)}>{c.name}</CellLink>
              </Fragment>
            ))}
          </td>
        )
      }
      default:
        return (
          <td className="img-td holder-actions">
            <Button
              size="sm"
              icon
              variant="ghost"
              className={clsx('pin-btn', pinned && 'pinned')}
              onClick={() => (pinned ? removeFromKeepList(image.id) : addToKeepList(image.id))}
              title={pinned ? 'Unpin this image' : 'Pin this image so it is never pruned'}
              aria-label={`${pinned ? 'Unpin' : 'Pin'} ${imageName(image)}`}
            >
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </Button>
          </td>
        )
    }
  }

  return (
    <div className="img-tab">
      <Toolbar>
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Search images"
          label="Search images by name, tag, or ID"
        />
        <Segmented label="Filter images">
          {FILTERS.map(({ key, label, title }) => (
            <SegmentedItem
              key={key}
              active={filter === key}
              count={images.filter(image => matchesImageFilter(image, key, dockerKeepList)).length}
              title={title}
              onClick={() => setFilter(key)}
            >
              {label}
            </SegmentedItem>
          ))}
        </Segmented>
        <span className="img-count">{rows.length} shown</span>
      </Toolbar>

      {rows.length === 0 && (
        <EmptyState
          title="No images match"
          description="Adjust the search or filters."
          actions={<Button onClick={() => { setSearch(''); setFilter('all') }}>Clear filters</Button>}
        />
      )}

      {rows.length > 0 && (
        <div className="img-table-wrap">
          <table className="img-table pkg-table" style={{ width: table.tableWidth }}>
            <TableHead table={table} sortKey={sortKey} sortDir={sortDir} onSort={handleSort} actionsClass="holder-actions" />
            <tbody>
              {rows.map(image => (
                <tr key={`${image.id}-${image.repository}-${image.tag}`} className={clsx('img-row', dockerKeepList.includes(image.id) && 'pinned')}>
                  {table.visible.map(column => <Fragment key={column.key}>{cell(column.key, image)}</Fragment>)}
                  {table.fillFixed && <td className="img-td" aria-hidden="true" />}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
