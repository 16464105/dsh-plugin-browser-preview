import z from '@deepseek-ai/schemastery'

/** Plugin-facing configuration; projected onto the auto-generated settings form. */
export interface Config {
  readonly headless: boolean
  /** Serve the picture over VNC (noVNC + websockify) instead of CDP frames. */
  readonly vnc: boolean
  readonly previewMode: 'screencast' | 'vnc'
  readonly screencastFps: number
  readonly screencastQuality: number
  readonly xvfbBin: string
  readonly xvfbDisplay: string
  readonly chromiumBin: string
  readonly chromiumArgs: readonly string[]
  readonly userDataDir: string
  readonly x11vncBin: string
  readonly websockifyBin: string
  readonly novncWebRoot: string
  readonly vncPort: number
  readonly novncPort: number
  readonly cdpPort: number
  readonly screenWidth: number
  readonly screenHeight: number
  readonly startTimeoutMs: number
  readonly autoStart: boolean
  readonly verbose: boolean
}

export const Config: z<Config> = z.object({
  // Headful Chromium does not publish the DevTools endpoint on every host, so
  // the default path is headless + CDP screencast: one browser, Agent and
  // preview share it.
  headless: z.boolean().default(true),
  vnc: z.boolean().default(false),
  previewMode: z.union([z.const('screencast'), z.const('vnc')]).default('screencast'),
  // Captures per second; 2 is plenty to watch an Agent work.
  screencastFps: z.number().default(2),
  screencastQuality: z.number().default(70),
  xvfbBin: z.string().default('Xvfb'),
  xvfbDisplay: z.string().default(':99'),
  // `auto` probes chromium / chromium-browser / google-chrome in order.
  chromiumBin: z.string().default('auto'),
  chromiumArgs: z
    .array(z.string())
    .default(['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--start-maximized']),
  userDataDir: z.string().default('/tmp/dsh-agent-chrome'),
  x11vncBin: z.string().default('x11vnc'),
  websockifyBin: z.string().default('websockify'),
  novncWebRoot: z.string().default('/usr/share/novnc'),
  vncPort: z.number().default(5900),
  novncPort: z.number().default(6080),
  cdpPort: z.number().default(9222),
  screenWidth: z.number().default(1600),
  screenHeight: z.number().default(900),
  startTimeoutMs: z.number().default(20_000),
  autoStart: z.boolean().default(true),
  verbose: z.boolean().default(false),
})
