import type { TableColumn } from '../../components/TableColumns'
import type { DockerTableTab } from '../../store/appStore'
import type { DockerContainer, DockerImage, DockerNetwork, DockerVolume } from './types'

export type SortDir = 'asc' | 'desc'
export type ContainerSortKey = 'name' | 'image' | 'status' | 'ports' | 'project' | 'service' | 'created' | 'id'
export type ImageSortKey = 'name' | 'id' | 'size' | 'created' | 'status'
export type VolumeSortKey = 'name' | 'driver' | 'project' | 'size' | 'status'
export type NetworkSortKey = 'name' | 'id' | 'driver' | 'scope' | 'created'

export type ContainerFilter = 'all' | 'running' | 'stopped'
export type ImageFilter = 'all' | 'in-use' | 'unused' | 'dangling' | 'pinned'
export type VolumeFilter = 'all' | 'in-use' | 'unused'
export type NetworkFilter = 'all' | 'custom' | 'built-in'

// The defaults that start visible add up to about 1000 or less, which fits a table at a 1280px window.
export const CONTAINER_COLUMNS: TableColumn<ContainerSortKey>[] = [
  { key: 'select',  label: 'Select',  width: 36 },
  { key: 'name',    label: 'Name',    width: 200, sort: 'name' },
  { key: 'image',   label: 'Image',   width: 200, sort: 'image',   hideable: true },
  { key: 'status',  label: 'Status',  width: 170, sort: 'status',  hideable: true },
  { key: 'ports',   label: 'Ports',   width: 150, sort: 'ports',   hideable: true },
  { key: 'project', label: 'Compose project', width: 150, sort: 'project', hideable: true },
  { key: 'service', label: 'Service', width: 130, sort: 'service', hideable: true },
  { key: 'created', label: 'Created', width: 120, sort: 'created', hideable: true },
  { key: 'id',      label: 'ID',      width: 120, sort: 'id',      hideable: true },
  { key: 'actions', label: 'Actions', width: 90 },
]

export const IMAGE_COLUMNS: TableColumn<ImageSortKey>[] = [
  { key: 'name',    label: 'Name',    width: 260, sort: 'name' },
  { key: 'id',      label: 'ID',      width: 120, sort: 'id',      hideable: true },
  { key: 'size',    label: 'Size',    width: 90,  sort: 'size',    hideable: true },
  { key: 'created', label: 'Created', width: 120, sort: 'created', hideable: true },
  { key: 'status',  label: 'Status',  width: 100, sort: 'status',  hideable: true },
  { key: 'used-by', label: 'Used by', width: 180, hideable: true },
  { key: 'actions', label: 'Actions', width: 90 },
]

export const VOLUME_COLUMNS: TableColumn<VolumeSortKey>[] = [
  { key: 'select',  label: 'Select',  width: 36 },
  { key: 'name',    label: 'Name',    width: 220, sort: 'name' },
  { key: 'driver',  label: 'Driver',  width: 90,  sort: 'driver',  hideable: true },
  { key: 'project', label: 'Compose project', width: 150, sort: 'project', hideable: true },
  { key: 'used-by', label: 'Used by', width: 180, hideable: true },
  { key: 'size',    label: 'Size',    width: 90,  sort: 'size',    hideable: true },
  { key: 'status',  label: 'Status',  width: 100, sort: 'status',  hideable: true },
  { key: 'actions', label: 'Actions', width: 160 },
]

export const NETWORK_COLUMNS: TableColumn<NetworkSortKey>[] = [
  { key: 'name',    label: 'Name',    width: 240, sort: 'name' },
  { key: 'id',      label: 'ID',      width: 120, sort: 'id',      hideable: true },
  { key: 'driver',  label: 'Driver',  width: 100, sort: 'driver',  hideable: true },
  { key: 'scope',   label: 'Scope',   width: 90,  sort: 'scope',   hideable: true },
  { key: 'options', label: 'Options', width: 120, hideable: true },
  { key: 'created', label: 'Created', width: 150, sort: 'created', hideable: true },
  { key: 'actions', label: 'Actions', width: 90 },
]

export const DOCKER_COLUMNS: Record<DockerTableTab, TableColumn<string>[]> = {
  containers: CONTAINER_COLUMNS,
  images: IMAGE_COLUMNS,
  volumes: VOLUME_COLUMNS,
  networks: NETWORK_COLUMNS,
}

type SortValue = string | number | null

/** Unknown values sort last in both directions, and ties fall back to the name. */
function sortRows<T>(rows: T[], valueOf: (row: T) => SortValue, nameOf: (row: T) => string, dir: SortDir): T[] {
  const text = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
  return [...rows].sort((a, b) => {
    const va = valueOf(a), vb = valueOf(b)
    const byName = text(nameOf(a), nameOf(b))
    if (va === null || vb === null) return va === vb ? byName : va === null ? 1 : -1
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : text(String(va), String(vb))
    return (dir === 'asc' ? cmp : -cmp) || byName
  })
}

const SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3_600, day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }

/** Docker only gives the age as text, such as "3 days ago" or "About an hour ago". */
export function ageSeconds(text: string): number | null {
  const match = text.toLowerCase().match(/(\d+|an?)\s+(second|minute|hour|day|week|month|year)/)
  if (!match) return null
  return (/^\d/.test(match[1]) ? Number(match[1]) : 1) * SECONDS[match[2]]
}

const newestLast = (text: string) => {
  const age = ageSeconds(text)
  return age === null ? null : -age
}

export interface PortMapping {
  /** One port, or a range such as "8000-8001". */
  host: string
  container: string
  proto: string
}

/** The published ports in `docker ps` text: "0.0.0.0:8000-8001->80-81/tcp, [::]:8000-8001->80-81/tcp, 9000/tcp".
 *  The same port on IPv4 and IPv6 counts once, and ports that are not published are left out. */
export function parsePorts(raw: string): PortMapping[] {
  const seen = new Set<string>()
  const ports: PortMapping[] = []
  for (const match of raw.matchAll(/(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(tcp|udp|sctp)/gi)) {
    const port = { host: match[1], container: match[2], proto: match[3].toLowerCase() }
    const key = `${port.host}:${port.container}/${port.proto}`
    if (seen.has(key)) continue
    seen.add(key)
    ports.push(port)
  }
  return ports
}

export const portLabel = ({ host, container }: PortMapping) => (host === container ? host : `${host}→${container}`)

/** The first port of a mapping, which is the one a browser can open. */
export const firstPort = ({ host }: PortMapping) => Number(host.split('-')[0])

export const containerDot = (state: string) => {
  const s = state.toLowerCase()
  if (s === 'running') return 'running'
  return s === 'paused' || s === 'restarting' ? 'partial' : 'stopped'
}

export function matchesContainerFilter(c: DockerContainer, filter: ContainerFilter): boolean {
  if (filter === 'running') return c.state === 'running'
  return filter === 'stopped' ? c.state !== 'running' : true
}

export function filterContainers(containers: DockerContainer[], query: string, filter: ContainerFilter): DockerContainer[] {
  const q = query.trim().toLowerCase().replace(/^:/, '')
  return containers.filter(c => matchesContainerFilter(c, filter)
    && (!q || [c.name, c.image, c.id, c.compose_project, c.compose_service, c.ports].some(text => (text ?? '').toLowerCase().includes(q))))
}

export function sortContainers(containers: DockerContainer[], key: ContainerSortKey, dir: SortDir): DockerContainer[] {
  const valueOf = (c: DockerContainer): SortValue => {
    switch (key) {
      case 'name':    return c.name
      case 'image':   return c.image
      case 'status':  return c.state
      case 'ports': {
        const [first] = parsePorts(c.ports)
        return first ? firstPort(first) : null
      }
      case 'project': return c.compose_project
      case 'service': return c.compose_service
      case 'created': return newestLast(c.created_since)
      case 'id':      return c.id
    }
  }
  return sortRows(containers, valueOf, c => c.name, dir)
}

export const imageName = (image: DockerImage) =>
  image.repository === '<none>' ? '<none>' : `${image.repository}:${image.tag}`

/** `docker ps` names an image without its tag when the tag is latest, and by ID when it has no name. */
export function containersUsing(image: DockerImage, containers: DockerContainer[]): DockerContainer[] {
  return containers.filter(({ image: used }) => used === imageName(image)
    || (image.tag === 'latest' && used === image.repository)
    || (used.length >= 12 && image.id.includes(used)))
}

export function matchesImageFilter(image: DockerImage, filter: ImageFilter, pinned: string[]): boolean {
  switch (filter) {
    case 'all':      return true
    case 'in-use':   return image.in_use
    case 'unused':   return !image.in_use && image.repository !== '<none>'
    case 'dangling': return !image.in_use && image.repository === '<none>'
    case 'pinned':   return pinned.includes(image.id)
  }
}

export const removableImages = (images: DockerImage[], pinned: string[]) =>
  images.filter(image => !image.in_use && !pinned.includes(image.id))

export function filterImages(images: DockerImage[], query: string, filter: ImageFilter, pinned: string[]): DockerImage[] {
  const q = query.trim().toLowerCase()
  return images.filter(image => matchesImageFilter(image, filter, pinned)
    && (!q || imageName(image).toLowerCase().includes(q) || image.id.toLowerCase().includes(q)))
}

export function sortImages(images: DockerImage[], key: ImageSortKey, dir: SortDir): DockerImage[] {
  const valueOf = (image: DockerImage): SortValue => {
    switch (key) {
      case 'name':    return imageName(image)
      case 'id':      return image.id
      case 'size':    return image.size_bytes
      case 'created': return newestLast(image.created_since)
      case 'status':  return image.in_use ? 'In use' : 'Unused'
    }
  }
  return sortRows(images, valueOf, imageName, dir)
}

export function matchesVolumeFilter(volume: DockerVolume, filter: VolumeFilter): boolean {
  if (filter === 'in-use') return volume.in_use
  return filter === 'unused' ? !volume.in_use : true
}

export function filterVolumes(volumes: DockerVolume[], query: string, filter: VolumeFilter): DockerVolume[] {
  const q = query.trim().toLowerCase()
  return volumes.filter(v => matchesVolumeFilter(v, filter)
    && (!q || [v.name, v.driver, v.compose_project, ...v.containers].some(text => (text ?? '').toLowerCase().includes(q))))
}

export function sortVolumes(volumes: DockerVolume[], key: VolumeSortKey, dir: SortDir): DockerVolume[] {
  const valueOf = (v: DockerVolume): SortValue => {
    switch (key) {
      case 'name':    return v.name
      case 'driver':  return v.driver
      case 'project': return v.compose_project
      case 'size':    return v.size_bytes || null
      case 'status':  return v.in_use ? 'In use' : 'Unused'
    }
  }
  return sortRows(volumes, valueOf, v => v.name, dir)
}

const BUILT_IN_NETWORKS = new Set(['bridge', 'host', 'none'])

/** Docker's own networks cannot be removed. */
export const isBuiltInNetwork = (network: DockerNetwork) => BUILT_IN_NETWORKS.has(network.name)

export const networkOptions = (network: DockerNetwork) =>
  [network.internal && 'Internal', network.ipv6 && 'IPv6'].filter(Boolean).join(', ')

export function matchesNetworkFilter(network: DockerNetwork, filter: NetworkFilter): boolean {
  if (filter === 'custom') return !isBuiltInNetwork(network)
  return filter === 'built-in' ? isBuiltInNetwork(network) : true
}

export function filterNetworks(networks: DockerNetwork[], query: string, filter: NetworkFilter): DockerNetwork[] {
  const q = query.trim().toLowerCase()
  return networks.filter(n => matchesNetworkFilter(n, filter)
    && (!q || [n.name, n.driver, n.id].some(text => text.toLowerCase().includes(q))))
}

export function sortNetworks(networks: DockerNetwork[], key: NetworkSortKey, dir: SortDir): DockerNetwork[] {
  const valueOf = (n: DockerNetwork): SortValue => {
    switch (key) {
      case 'name':    return n.name
      case 'id':      return n.id
      case 'driver':  return n.driver
      case 'scope':   return n.scope
      case 'created': return n.created || null
    }
  }
  return sortRows(networks, valueOf, n => n.name, dir)
}
