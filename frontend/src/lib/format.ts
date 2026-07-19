/** Avatar palette from the design system. */
const AVATAR_COLORS = [
  '#6c5ce7',
  '#2fa88c',
  '#d9822b',
  '#c2447a',
  '#3d7cd9',
  '#8b6cc4',
] as const

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (parts.length === 0) return '?'

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()
}

/** Stable per-user colour, so an avatar keeps its hue across sessions. */
export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

const MINUTE = 60_000
const DAY = 86_400_000

/** Sidebar timestamp: time today, "Yesterday", weekday this week, else a date. */
export function formatChatTime(iso: string | null): string {
  if (!iso) return ''

  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const daysAgo = Math.floor((startOfToday.getTime() - date.getTime()) / DAY) + 1

  if (date.getTime() >= startOfToday.getTime()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  if (daysAgo <= 1) return 'Yesterday'
  if (daysAgo < 7) return date.toLocaleDateString([], { weekday: 'short' })

  return date.toLocaleDateString([], { day: '2-digit', month: 'short' })
}

/** Bubble timestamp. */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatRelative(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const elapsed = Date.now() - date.getTime()
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < DAY) return `${Math.floor(elapsed / MINUTE / 60) || 1}h ago`

  return `${Math.floor(elapsed / DAY)}d ago`
}
