/**
 * Contract shared by the host half and the Web client half.
 *
 * Kept free of Node types on purpose: the client bundle inlines this module,
 * so it must stay browser-safe.
 */

/** Route prefix every HTTP path of this plugin lives under (same-origin). */
export const ROUTE_PREFIX = '/browser-preview'

/** Status endpoint the floating window polls. */
export const STATUS_PATH = `${ROUTE_PREFIX}/api/status`

/** The single WebSocket path the Web server hands to the noVNC bridge. */
export const WS_PATH = `${ROUTE_PREFIX}/ws`

/** Live CDP screencast frames (binary JPEG) plus input back-channel. */
export const STREAM_PATH = `${ROUTE_PREFIX}/stream`

/** Standalone full-screen viewer (what the ↗ button opens). */
export const VIEW_PATH = `${ROUTE_PREFIX}/view`

/** Upstream path websockify serves the VNC WebSocket on. */
export const NOVNC_UPSTREAM_WS_PATH = '/websockify'

/** noVNC entry document, with the WebSocket path pinned to {@link WS_PATH}. */
export const NOVNC_ENTRY_PATH = `${ROUTE_PREFIX}/vnc.html`

/** Pin the preview to one page: POST { id } or POST { id: null } to follow. */
export const TARGET_PATH = `${ROUTE_PREFIX}/api/target`

/** One open page in the shared browser, shown as a tab in the preview. */
export interface TargetSummary {
  readonly id: string
  readonly url: string
  readonly title: string
}

export type StackPhase = 'stopped' | 'starting' | 'ready' | 'degraded' | 'error'

/** Process names in startup order; teardown walks the reverse. */
export const STACK_PROC_ORDER = ['Xvfb', 'chromium', 'x11vnc', 'websockify'] as const

export type StackProcName = (typeof STACK_PROC_ORDER)[number]

/** Snapshot returned by {@link STATUS_PATH} and rendered by the client. */
export interface StackSnapshot {
  /** `ready` is the only field the client gates the iframe on. */
  readonly ready: boolean
  readonly phase: StackPhase
  readonly display: string
  readonly cdpPort: number
  readonly vncPort: number
  readonly novncPort: number
  /** Processes this plugin owns right now. */
  readonly running: readonly StackProcName[]
  /** Binaries not found on PATH. */
  readonly missing: readonly StackProcName[]
  /** Processes reused from an already-running stack (not spawned here). */
  readonly reused: readonly StackProcName[]
  /** Which picture channel the client should render. */
  readonly previewMode: 'screencast' | 'vnc'
  readonly screencast: boolean
  readonly vnc: boolean
  readonly message: string | undefined
}

/** One session's page: what the tab strip is really grouping by. */
export interface SessionTarget {
  readonly sessionId: string
  readonly targetId: string
}

/** What {@link STATUS_PATH} actually returns: stack state plus preview state. */
export interface PreviewStatus extends StackSnapshot {
  /** Pages open in the shared browser; several sessions share one instance. */
  readonly targets: readonly TargetSummary[]
  /** Which page each session opened, learned from the MCP `open` results. */
  readonly sessions: readonly SessionTarget[]
  /** Pinned target id, or null while following the newest page. */
  readonly selected: string | null
  readonly viewers: number
  readonly stream: Record<string, unknown> | null
}
