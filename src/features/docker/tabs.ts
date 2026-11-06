import { Box, Database, Layers, Network, ScrollText, Trash2, type LucideIcon } from 'lucide-react'
import type { DockerTab } from '../../store/appStore'

export const DOCKER_TABS: { id: DockerTab; label: string; icon: LucideIcon }[] = [
  { id: 'overview',   label: 'Overview',   icon: Box },
  { id: 'images',     label: 'Images',     icon: Layers },
  { id: 'containers', label: 'Containers', icon: Box },
  { id: 'volumes',    label: 'Volumes',    icon: Database },
  { id: 'networks',   label: 'Networks',   icon: Network },
  { id: 'compose',    label: 'Compose',    icon: Layers },
  { id: 'prune',      label: 'Prune',      icon: Trash2 },
  { id: 'log',        label: 'Run log',    icon: ScrollText },
]
