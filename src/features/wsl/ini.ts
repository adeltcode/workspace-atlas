// Minimal, comment-preserving INI helpers for .wslconfig. The raw file text is
// the single source of truth; the form reads values from it and writes surgical
// edits back, so comments, ordering, and unknown keys are all preserved.

// 'text' covers everything that renders as a free-form input (numbers, sizes, paths).
export type FieldType = 'bool' | 'enum' | 'text'

export interface WslField {
  key: string
  label: string
  type: FieldType
  hint?: string
  options?: string[]
  placeholder?: string
  /** Surfaced by default; non-common keys live under "advanced". */
  common?: boolean
}

export interface WslSection {
  name: string
  title: string
  fields: WslField[]
}

/** All documented .wslconfig keys, grouped by section. */
export const WSLCONFIG_SECTIONS: WslSection[] = [
  {
    name: 'wsl2',
    title: '[wsl2]',
    fields: [
      { key: 'processors', label: 'Processors', type: 'text', hint: 'Logical processors available to WSL2', placeholder: 'e.g. 4', common: true },
      { key: 'memory', label: 'Memory', type: 'text', hint: 'Max memory (default: 50% of host or 8GB)', placeholder: 'e.g. 8GB', common: true },
      { key: 'swap', label: 'Swap', type: 'text', hint: 'Swap size (0 disables swap)', placeholder: 'e.g. 2GB', common: true },
      { key: 'swapFile', label: 'Swap file', type: 'text', hint: 'Path to the swap VHD', placeholder: 'e.g. C:\\\\swap.vhdx' },
      { key: 'localhostForwarding', label: 'localhost forwarding', type: 'bool', hint: 'Forward localhost ports to Windows (default: on)', common: true },
      { key: 'networkingMode', label: 'Networking mode', type: 'enum', options: ['NAT', 'mirrored'], hint: 'mirrored shares the host network', common: true },
      { key: 'firewall', label: 'Firewall', type: 'bool', hint: 'Apply Windows Firewall rules to WSL (default: on)' },
      { key: 'dnsTunneling', label: 'DNS tunneling', type: 'bool', hint: 'Tunnel DNS queries through Windows' },
      { key: 'autoProxy', label: 'Auto proxy', type: 'bool', hint: 'Use the Windows HTTP proxy settings' },
      { key: 'ignoredPorts', label: 'Ignored ports', type: 'text', hint: 'Ports WSL will not bind in mirrored mode (comma-separated)', placeholder: 'e.g. 3000,8080' },
      { key: 'nestedVirtualization', label: 'Nested virtualization', type: 'bool', hint: 'Run VMs inside WSL2 (default: on)' },
      { key: 'vmIdleTimeout', label: 'VM idle timeout', type: 'text', hint: 'Milliseconds before the idle VM shuts down', placeholder: 'e.g. 60000' },
      { key: 'guiApplications', label: 'GUI applications', type: 'bool', hint: 'Enable WSLg Linux GUI apps (default: on)' },
      { key: 'pageReporting', label: 'Page reporting', type: 'bool', hint: 'Return freed memory to Windows (default: on)' },
      { key: 'debugConsole', label: 'Debug console', type: 'bool', hint: 'Show the kernel debug console window' },
      { key: 'safeMode', label: 'Safe mode', type: 'bool', hint: 'Minimal feature set for troubleshooting' },
      { key: 'defaultVhdSize', label: 'Default VHD size', type: 'text', hint: 'Max size of new distro virtual disks', placeholder: 'e.g. 1TB' },
      { key: 'kernel', label: 'Custom kernel', type: 'text', hint: 'Path to a custom kernel image', placeholder: 'e.g. C:\\\\kernel' },
      { key: 'kernelModules', label: 'Kernel modules', type: 'text', hint: 'Path to a custom kernel-modules VHD', placeholder: 'e.g. C:\\\\modules.vhdx' },
      { key: 'kernelCommandLine', label: 'Kernel command line', type: 'text', hint: 'Extra kernel boot arguments', placeholder: 'e.g. cgroup_no_v1=all' },
    ],
  },
  {
    name: 'experimental',
    title: '[experimental]',
    fields: [
      { key: 'autoMemoryReclaim', label: 'Auto memory reclaim', type: 'enum', options: ['disabled', 'gradual', 'dropcache'], hint: 'Return cached memory to Windows' },
      { key: 'sparseVhd', label: 'Sparse VHD', type: 'bool', hint: 'Automatically make new VHDs sparse' },
      { key: 'useWindowsDnsCache', label: 'Windows DNS cache', type: 'bool', hint: 'Resolve via the Windows DNS cache' },
      { key: 'bestEffortDnsParsing', label: 'Best-effort DNS parsing', type: 'bool', hint: 'Forward the question on DNS parse failure' },
      { key: 'hostAddressLoopback', label: 'Host address loopback', type: 'bool', hint: 'Allow container↔host loopback in mirrored mode' },
    ],
  },
]

/** All documented /etc/wsl.conf keys (per-distro), grouped by section. */
export const WSLCONF_SECTIONS: WslSection[] = [
  {
    name: 'boot',
    title: '[boot]',
    fields: [
      { key: 'systemd', label: 'systemd', type: 'bool', hint: 'Run systemd as init (WSL 0.67.6+)' },
      { key: 'command', label: 'Boot command', type: 'text', hint: 'Command run as root at every boot', placeholder: 'e.g. service docker start' },
    ],
  },
  {
    name: 'automount',
    title: '[automount]',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool', hint: 'Auto-mount Windows drives (default: on)' },
      { key: 'mountFsTab', label: 'Process fstab', type: 'bool', hint: 'Process /etc/fstab on boot (default: on)' },
      { key: 'root', label: 'Mount root', type: 'text', hint: 'Where Windows drives mount (default: /mnt/)', placeholder: 'e.g. /mnt/' },
      { key: 'options', label: 'Mount options', type: 'text', hint: 'Options for mounted Windows drives', placeholder: 'e.g. metadata,uid=1000' },
    ],
  },
  {
    name: 'interop',
    title: '[interop]',
    fields: [
      { key: 'enabled', label: 'Enabled', type: 'bool', hint: 'Allow launching Windows processes (default: on)' },
      { key: 'appendWindowsPath', label: 'Append Windows PATH', type: 'bool', hint: 'Add the Windows PATH to $PATH (default: on)' },
    ],
  },
  {
    name: 'network',
    title: '[network]',
    fields: [
      { key: 'hostname', label: 'Hostname', type: 'text', hint: 'Hostname for the distro', placeholder: 'e.g. devbox' },
      { key: 'generateHosts', label: 'Generate hosts', type: 'bool', hint: 'Auto-generate /etc/hosts (default: on)' },
      { key: 'generateResolvConf', label: 'Generate resolv.conf', type: 'bool', hint: 'Auto-generate /etc/resolv.conf (default: on)' },
    ],
  },
  {
    name: 'user',
    title: '[user]',
    fields: [
      { key: 'default', label: 'Default user', type: 'text', hint: 'User to log in as by default', placeholder: 'e.g. patrick' },
    ],
  },
]

function sectionOf(line: string): string | null {
  const m = line.match(/^\s*\[(.+?)\]\s*$/)
  return m ? m[1].trim().toLowerCase() : null
}

function isComment(line: string): boolean {
  return /^\s*[#;]/.test(line)
}

function lineKey(line: string): string | null {
  const m = line.match(/^\s*([A-Za-z0-9_.]+)\s*=/)
  return m ? m[1].toLowerCase() : null
}

/** Read a key's value within a section, or undefined if unset. */
export function getIniValue(text: string, section: string, key: string): string | undefined {
  const sec = section.toLowerCase()
  const k = key.toLowerCase()
  let cur: string | null = null
  for (const line of text.split('\n')) {
    const h = sectionOf(line)
    if (h !== null) { cur = h; continue }
    if (cur === sec && !isComment(line) && lineKey(line) === k) {
      return line.slice(line.indexOf('=') + 1).trim()
    }
  }
  return undefined
}

/**
 * Set (or, when value is empty, remove) a key within a section, preserving every
 * other line. Creates the section if needed. Returns the new text.
 */
export function setIniValue(text: string, section: string, key: string, value: string): string {
  const sec = section.toLowerCase()
  const k = key.toLowerCase()
  const want = value.trim()
  const lines = text.split('\n')

  let cur: string | null = null
  let secStart = -1   // first line index inside the target section
  let secEnd = -1     // exclusive end of the target section's lines
  let keyIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const h = sectionOf(lines[i])
    if (h !== null) {
      if (cur === sec) { secEnd = i; break }
      cur = h
      if (cur === sec) secStart = i + 1
      continue
    }
    if (cur === sec && !isComment(lines[i]) && lineKey(lines[i]) === k) keyIdx = i
  }
  if (cur === sec && secEnd === -1) secEnd = lines.length

  // Key already present: replace or remove it.
  if (keyIdx >= 0) {
    if (want === '') lines.splice(keyIdx, 1)
    else lines[keyIdx] = `${key}=${want}`
    return lines.join('\n')
  }

  // Unsetting a key that isn't there is a no-op.
  if (want === '') return text

  // Section exists, key absent: insert after the section's last non-blank line.
  if (secStart >= 0) {
    let at = secEnd
    while (at > secStart && lines[at - 1].trim() === '') at--
    lines.splice(at, 0, `${key}=${want}`)
    return lines.join('\n')
  }

  // Section missing: append a new block.
  const base = text.replace(/\s*$/, '')
  const block = `[${section}]\n${key}=${want}\n`
  return base === '' ? block : `${base}\n\n${block}`
}
