// src/shared.ts
var ROUTE_PREFIX = "/browser-preview";
var STATUS_PATH = `${ROUTE_PREFIX}/api/status`;
var WS_PATH = `${ROUTE_PREFIX}/ws`;
var STREAM_PATH = `${ROUTE_PREFIX}/stream`;
var VIEW_PATH = `${ROUTE_PREFIX}/view`;
var NOVNC_UPSTREAM_WS_PATH = "/websockify";
var NOVNC_ENTRY_PATH = `${ROUTE_PREFIX}/vnc.html`;
var TARGET_PATH = `${ROUTE_PREFIX}/api/target`;
var DEPS_PATH = `${ROUTE_PREFIX}/api/deps`;
var NO_TARGET = "";
var STACK_PROC_ORDER = ["Xvfb", "chromium", "x11vnc", "websockify"];

// src/config.ts
import z from "@deepseek-ai/schemastery";
var Config = z.object({
  // Headful Chromium does not publish the DevTools endpoint on every host, so
  // the default path is headless + CDP screencast: one browser, Agent and
  // preview share it.
  headless: z.boolean().default(true),
  vnc: z.boolean().default(false),
  previewMode: z.union([z.const("screencast"), z.const("vnc")]).default("screencast"),
  // Captures per second; 2 is plenty to watch an Agent work.
  screencastFps: z.number().default(2),
  screencastQuality: z.number().default(70),
  xvfbBin: z.string().default("Xvfb"),
  xvfbDisplay: z.string().default(":99"),
  // `auto` probes chromium / chromium-browser / google-chrome in order.
  chromiumBin: z.string().default("auto"),
  chromiumArgs: z.array(z.string()).default(["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--start-maximized"]),
  userDataDir: z.string().default("/tmp/dsh-agent-chrome"),
  x11vncBin: z.string().default("x11vnc"),
  websockifyBin: z.string().default("websockify"),
  novncWebRoot: z.string().default("/usr/share/novnc"),
  vncPort: z.number().default(5900),
  novncPort: z.number().default(6080),
  cdpPort: z.number().default(9222),
  screenWidth: z.number().default(1600),
  screenHeight: z.number().default(900),
  startTimeoutMs: z.number().default(2e4),
  autoStart: z.boolean().default(true),
  autoInstall: z.union([z.const("off"), z.const("on-start")]).default("off"),
  installTimeoutMs: z.number().default(6e5),
  keepBrowser: z.boolean().default(true),
  verbose: z.boolean().default(false)
});

// src/stack.ts
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
var CHROMIUM_CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
async function which(command) {
  if (command.includes("/")) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return void 0;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, command);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
    }
  }
  return void 0;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function tcpProbe(port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
async function cdpProbe(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1e3) });
      if (res.ok) return true;
    } catch {
    }
    await sleep(300);
  }
  return false;
}
var BrowserStack = class {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
  }
  procs = /* @__PURE__ */ new Map();
  phase = "stopped";
  /** Stages adopted from an already-running instance rather than spawned. */
  adopted = /* @__PURE__ */ new Set();
  missing = [];
  message;
  stopping = false;
  chromiumBinResolved;
  get snapshot() {
    const ready = this.phase === "ready" || this.phase === "degraded";
    return {
      ready,
      previewMode: this.config.previewMode,
      screencast: this.config.previewMode === "screencast" && ready,
      vnc: this.config.vnc && ready,
      phase: this.phase,
      display: this.config.xvfbDisplay,
      cdpPort: this.config.cdpPort,
      vncPort: this.config.vncPort,
      novncPort: this.config.novncPort,
      running: [...this.procs.keys()],
      missing: this.missing,
      reused: [...this.adopted],
      message: this.message
    };
  }
  async start() {
    if (this.phase === "starting" || this.phase === "ready") return;
    this.phase = "starting";
    this.adopted.clear();
    this.message = void 0;
    try {
      const missing = await this.probeBinaries();
      this.missing = missing;
      if (missing.length > 0) {
        this.phase = "error";
        this.message = `\u7F3A\u5C11\u53EF\u6267\u884C\u6587\u4EF6\uFF1A${missing.join("\u3001")}\u3002Debian/Ubuntu: apt install -y xvfb chromium x11vnc novnc websockify\uFF1BTencentOS/RHEL: dnf install -y xorg-x11-server-Xvfb google-chrome-stable x11vnc novnc python3-websockify`;
        this.ctx.logger.warn(`browser-preview: ${this.message}`);
        return;
      }
      if (this.config.vnc) await this.ensureXvfb();
      await this.ensureChromium();
      if (this.config.vnc) {
        await this.ensureVnc();
        await this.ensureNoVnc();
      }
      this.phase = "ready";
      this.message = void 0;
      this.ctx.logger.info(
        `browser-preview: stack ready (CDP ws://127.0.0.1:${this.config.cdpPort}, noVNC 127.0.0.1:${this.config.novncPort})`
      );
    } catch (error) {
      this.phase = "error";
      this.message = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)));
      await this.stop();
    }
  }
  async stop(options = {}) {
    this.stopping = true;
    for (const name2 of [...STACK_PROC_ORDER].reverse()) {
      const proc = this.procs.get(name2);
      if (proc === void 0) continue;
      this.procs.delete(name2);
      if (proc.reused || proc.exited) continue;
      if (options.keepBrowser === true && name2 === "chromium") {
        this.ctx.logger.info("browser-preview: \u4FDD\u7559\u6B63\u5728\u8FD0\u884C\u7684 Chromium\uFF08keepBrowser\uFF09");
        continue;
      }
      await this.terminate(proc);
    }
    this.phase = "stopped";
    this.stopping = false;
    if (options.keepBrowser !== true) this.adopted.clear();
  }
  /** Binaries absent from PATH; the status endpoint reports them verbatim. */
  async probeBinaries() {
    const chromium = await this.resolveChromium();
    const wanted = [["chromium", chromium]];
    if (this.config.vnc) {
      wanted.push(["Xvfb", this.config.xvfbBin], ["x11vnc", this.config.x11vncBin], ["websockify", this.config.websockifyBin]);
    }
    const missing = [];
    for (const [name2, bin] of wanted) {
      if (bin === void 0 || await which(bin) === void 0) missing.push(name2);
    }
    if (missing.length === 0 && !await this.exists(this.config.novncWebRoot)) {
      this.message = `noVNC \u9759\u6001\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${this.config.novncWebRoot}\uFF08\u914D\u7F6E novncWebRoot\uFF09`;
      this.ctx.logger.warn(`browser-preview: ${this.message}`);
    }
    return missing;
  }
  /**
   * Resolve the browser binary once: an explicit path from config, otherwise
   * the first candidate on PATH. `undefined` means "not installed" and is what
   * the status endpoint reports, so probing and spawning never disagree.
   */
  async resolveChromium() {
    if (this.chromiumBinResolved !== void 0) return this.chromiumBinResolved;
    if (this.config.chromiumBin !== "auto") {
      this.chromiumBinResolved = await which(this.config.chromiumBin);
      return this.chromiumBinResolved;
    }
    for (const candidate of CHROMIUM_CANDIDATES) {
      const found = await which(candidate);
      if (found !== void 0) {
        this.chromiumBinResolved = found;
        return found;
      }
    }
    return void 0;
  }
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
  async ensureXvfb() {
    const socket = `/tmp/.X11-unix/X${this.config.xvfbDisplay.replace(/^:/, "")}`;
    if (await this.exists(socket)) {
      this.ctx.logger.info(`browser-preview: reusing Xvfb ${this.config.xvfbDisplay}`);
      return;
    }
    const bin = this.config.xvfbBin;
    await this.spawn("Xvfb", bin, [
      this.config.xvfbDisplay,
      "-screen",
      "0",
      `${this.config.screenWidth}x${this.config.screenHeight}x24`,
      "-ac",
      "-nolisten",
      "tcp"
    ]);
    const deadline = Date.now() + this.config.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.exists(socket)) return;
      await sleep(300);
    }
    throw new Error(`Xvfb \u672A\u80FD\u5728 ${this.config.startTimeoutMs}ms \u5185\u521B\u5EFA ${socket}`);
  }
  async ensureChromium() {
    if (await cdpProbe(this.config.cdpPort, 1500)) {
      this.ctx.logger.info(`browser-preview: reusing Chromium on CDP ${this.config.cdpPort}`);
      this.adopted.add("chromium");
      return;
    }
    const bin = await this.resolveChromium();
    if (bin === void 0) throw new Error("\u672A\u627E\u5230 Chromium/Chrome \u53EF\u6267\u884C\u6587\u4EF6\uFF08\u8BF7\u914D\u7F6E chromiumBin\uFF09");
    await mkdir(this.config.userDataDir, { recursive: true });
    await this.spawn(
      "chromium",
      bin,
      [
        ...this.config.headless ? ["--headless=new"] : [],
        `--remote-debugging-port=${this.config.cdpPort}`,
        `--user-data-dir=${this.config.userDataDir}`,
        `--window-size=${this.config.screenWidth},${this.config.screenHeight}`,
        ...this.config.chromiumArgs,
        "about:blank"
      ],
      { ...process.env, DISPLAY: this.config.xvfbDisplay }
    );
    if (this.config.headless) {
      if (!await cdpProbe(this.config.cdpPort, this.config.startTimeoutMs)) {
        throw new Error(`Chromium \u672A\u80FD\u5728 ${this.config.startTimeoutMs}ms \u5185\u5F00\u653E CDP \u7AEF\u53E3 ${this.config.cdpPort}`);
      }
      return;
    }
    await sleep(3e3);
  }
  async ensureVnc() {
    if (await tcpProbe(this.config.vncPort, 500)) {
      this.ctx.logger.info(`browser-preview: reusing VNC server on ${this.config.vncPort}`);
      return;
    }
    await this.spawn(
      "x11vnc",
      this.config.x11vncBin,
      ["-display", this.config.xvfbDisplay, "-forever", "-nopw", "-shared", "-rfbport", String(this.config.vncPort), "-listen", "127.0.0.1"],
      { ...process.env, DISPLAY: this.config.xvfbDisplay }
    );
    if (!await this.waitForPort(this.config.vncPort)) {
      throw new Error(`x11vnc \u672A\u80FD\u5728 ${this.config.startTimeoutMs}ms \u5185\u76D1\u542C ${this.config.vncPort}`);
    }
  }
  async ensureNoVnc() {
    if (await tcpProbe(this.config.novncPort, 500)) {
      this.ctx.logger.info(`browser-preview: reusing websockify on ${this.config.novncPort}`);
      return;
    }
    await this.spawn("websockify", this.config.websockifyBin, [
      "--web",
      this.config.novncWebRoot,
      String(this.config.novncPort),
      `127.0.0.1:${this.config.vncPort}`
    ]);
    if (!await this.waitForPort(this.config.novncPort)) {
      throw new Error(`websockify \u672A\u80FD\u5728 ${this.config.startTimeoutMs}ms \u5185\u76D1\u542C ${this.config.novncPort}`);
    }
  }
  async waitForPort(port) {
    const deadline = Date.now() + this.config.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await tcpProbe(port, 500)) return true;
      await sleep(300);
    }
    return false;
  }
  async spawn(name2, bin, argv, env) {
    const child = spawn(bin, argv, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const proc = { name: name2, child, exited: false, reused: false };
    this.procs.set(name2, proc);
    child.on("error", (error) => {
      proc.exited = true;
      this.degrade(`${name2} \u542F\u52A8\u5931\u8D25\uFF1A${error.message}`);
    });
    child.on("exit", (code, signal) => {
      proc.exited = true;
      if (!this.stopping) this.degrade(`${name2} \u5DF2\u9000\u51FA\uFF08code=${code} signal=${signal}\uFF09`);
    });
    this.pipeLog(name2, child);
    child.unref();
  }
  pipeLog(name2, child) {
    const forward = (stream, level) => {
      stream?.setEncoding("utf8");
      let lines = 0;
      stream?.on("data", (chunk) => {
        for (const line of chunk.split("\n")) {
          const text = line.trim();
          if (text.length === 0) continue;
          lines += 1;
          if (this.config.verbose || lines <= 10) this.ctx.logger[level](`browser-preview/${name2}: ${text}`);
        }
      });
    };
    forward(child.stdout, "debug");
    forward(child.stderr, "warn");
  }
  degrade(message) {
    if (this.phase === "stopped") return;
    this.phase = "degraded";
    this.message = message;
    this.ctx.logger.warn(`browser-preview: ${message}`);
  }
  async terminate(proc) {
    const pid = proc.child.pid;
    if (pid === void 0) return;
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      const signal = (name2) => {
        try {
          process.kill(-pid, name2);
        } catch {
          try {
            proc.child.kill(name2);
          } catch {
          }
        }
      };
      const killTimer = setTimeout(() => {
        signal("SIGKILL");
        finish();
      }, 3e3);
      proc.child.once("exit", finish);
      signal("SIGTERM");
    });
  }
};

// src/deps.ts
import { execFile } from "node:child_process";
import { constants as fsConstants2, existsSync, readFileSync } from "node:fs";
import { access as access2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var PLATFORMS = [
  {
    id: "tencentos/rhel/fedora",
    manager: "dnf",
    packages: {
      // No chromium in TencentOS repos: fall back to Google's RPM.
      chromium: ["chromium", "https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm"],
      fonts: ["google-noto-sans-cjk-ttc-fonts"],
      Xvfb: ["xorg-x11-server-Xvfb"],
      x11vnc: ["x11vnc"],
      novnc: ["novnc"],
      websockify: ["python3-websockify", "websockify"]
    }
  },
  {
    id: "debian/ubuntu",
    manager: "apt",
    packages: {
      chromium: ["chromium", "chromium-browser"],
      fonts: ["fonts-noto-cjk"],
      Xvfb: ["xvfb"],
      x11vnc: ["x11vnc"],
      novnc: ["novnc"],
      websockify: ["websockify"]
    }
  }
];
function detectPlatform() {
  let id = "";
  try {
    const osRelease = readFileSync("/etc/os-release", "utf8");
    id = [...osRelease.matchAll(/^ID(?:_LIKE)?=(.+)$/gm)].map((match) => match[1].replace(/"/g, "")).join(" ");
  } catch {
  }
  const debian = /debian|ubuntu/.test(id);
  return PLATFORMS[debian ? 1 : 0];
}
function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
async function run(command, args, timeoutMs) {
  const { stdout, stderr } = await execFileAsync(command, [...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" }
  });
  return `${stdout}${stderr}`.trim();
}
async function installDep(dep, platform, timeoutMs, log) {
  const candidates = platform.packages[dep] ?? [];
  for (const pkg of candidates) {
    const base = platform.manager === "dnf" ? ["dnf", "install", "-y"] : ["apt-get", "install", "-y"];
    const argv = [...base, pkg];
    const command = isRoot() ? argv[0] : "sudo";
    const args = isRoot() ? argv.slice(1) : ["-n", ...argv];
    try {
      log.push(`$ ${isRoot() ? "" : "sudo -n "}${argv.join(" ")}`);
      await run(command, args, timeoutMs);
      log.push(`\u5DF2\u5B89\u88C5 ${dep} \u2190 ${pkg}`);
      return true;
    } catch (error) {
      log.push(`\u5931\u8D25 ${dep} \u2190 ${pkg}\uFF1A${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }
  return false;
}
async function installDeps(deps, timeoutMs = 6e5) {
  const platform = detectPlatform();
  const log = [];
  const installed = [];
  const failed = [];
  for (const dep of deps) {
    if (await installDep(dep, platform, timeoutMs, log)) installed.push(dep);
    else failed.push(dep);
  }
  if (installed.includes("fonts")) {
    try {
      await run("fc-cache", ["-f"], 3e4);
      log.push("\u5DF2\u5237\u65B0\u5B57\u4F53\u7F13\u5B58");
    } catch (error) {
      log.push(`\u5B57\u4F53\u7F13\u5B58\u5237\u65B0\u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { platform: platform.id, manager: platform.manager, root: isRoot(), installed, failed, log };
}
var CHROMIUM_CANDIDATES2 = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
async function which2(command) {
  if (command.includes("/")) return existsSync(command) ? command : void 0;
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join2(dir, command);
    try {
      await access2(candidate, fsConstants2.X_OK);
      return candidate;
    } catch {
    }
  }
  return void 0;
}
async function versionOf(bin) {
  try {
    const out = await run(bin, ["--version"], 5e3);
    return out.split("\n")[0]?.trim() ?? "";
  } catch {
    return "";
  }
}
async function probeEnvironment(options) {
  const items = [];
  let chromiumPath = options.chromiumBin === "auto" ? void 0 : await which2(options.chromiumBin);
  if (chromiumPath === void 0 && options.chromiumBin === "auto") {
    for (const candidate of CHROMIUM_CANDIDATES2) {
      chromiumPath = await which2(candidate);
      if (chromiumPath !== void 0) break;
    }
  }
  const chromiumVersion = chromiumPath === void 0 ? "" : await versionOf(chromiumPath);
  items.push({
    id: "chromium",
    label: "\u6D4F\u89C8\u5668\uFF08Chromium / Chrome\uFF09",
    ok: chromiumPath !== void 0,
    needed: true,
    detail: chromiumPath === void 0 ? "\u672A\u5728 PATH \u4E2D\u627E\u5230" : `${chromiumPath} ${chromiumVersion}`,
    installable: true
  });
  const fontsOk = await hasCjkFont();
  let fontDetail = "\u65E0\u4E2D\u6587\u5B57\u5F62\uFF08\u9875\u9762\u6C49\u5B57\u4F1A\u663E\u793A\u4E3A\u65B9\u5757\uFF09";
  if (fontsOk) {
    try {
      fontDetail = (await run("fc-list", [":lang=zh"], 1e4)).split("\n")[0]?.split(":")[1]?.trim() ?? "\u5DF2\u5B89\u88C5";
    } catch {
      fontDetail = "\u5DF2\u5B89\u88C5";
    }
  }
  items.push({
    id: "fonts",
    label: "\u4E2D\u6587\u5B57\u4F53\uFF08CJK\uFF09",
    ok: fontsOk,
    needed: true,
    detail: fontDetail,
    installable: true
  });
  const binaries = [
    ["Xvfb", "Xvfb", "Xvfb\uFF08VNC \u6A21\u5F0F\uFF09"],
    ["x11vnc", "x11vnc", "x11vnc\uFF08VNC \u6A21\u5F0F\uFF09"],
    ["websockify", "websockify", "websockify\uFF08VNC \u6A21\u5F0F\uFF09"]
  ];
  for (const [dep, command, label] of binaries) {
    const found = await which2(command);
    items.push({
      id: dep,
      label,
      ok: found !== void 0,
      needed: options.vnc,
      detail: found ?? "\u672A\u5728 PATH \u4E2D\u627E\u5230",
      installable: true
    });
  }
  const novncOk = existsSync(options.novncWebRoot);
  items.push({
    id: "novnc",
    label: "noVNC \u9759\u6001\u8D44\u6E90\uFF08VNC \u6A21\u5F0F\uFF09",
    ok: novncOk,
    needed: options.vnc,
    detail: novncOk ? options.novncWebRoot : `\u76EE\u5F55\u4E0D\u5B58\u5728\uFF1A${options.novncWebRoot}`,
    installable: true
  });
  return items;
}
async function hasCjkFont() {
  try {
    const out = await run("fc-list", [":lang=zh"], 1e4);
    return out.trim().length > 0;
  } catch {
    return true;
  }
}
function platformInfo() {
  const platform = detectPlatform();
  return { platform: platform.id, manager: platform.manager, root: isRoot() };
}

// src/cdp.ts
import { get } from "node:http";
var WebSocketCtor = globalThis.WebSocket;
var RETARGET_MS = 4e3;
var CALL_TIMEOUT_MS = 5e3;
var ScreencastBridge = class {
  constructor(ctx, port, fps, quality, onFrame) {
    this.ctx = ctx;
    this.port = port;
    this.fps = fps;
    this.quality = quality;
    this.onFrame = onFrame;
  }
  socket;
  targetUrl;
  nextId = 1;
  viewport = { width: 1280, height: 800 };
  pending = /* @__PURE__ */ new Map();
  retargetTimer;
  captureTimer;
  lastFrame;
  frames = 0;
  captured = 0;
  lastError;
  timeouts = 0;
  closed = false;
  /** Pinned target id; `undefined` means "follow the newest page". */
  selected;
  lastTargets = [];
  get connected() {
    return this.socket?.readyState === 1;
  }
  /** Latest pushed frame, replayed to a viewer that just connected. */
  get currentFrame() {
    return this.lastFrame;
  }
  /** Surfaced on the status endpoint — the only way to see inside the bridge. */
  get diagnostics() {
    return {
      started: this.captureTimer !== void 0,
      connected: this.connected,
      fps: this.fps,
      frames: this.frames,
      captured: this.captured,
      target: this.targetUrl ?? null,
      selected: this.selected ?? null,
      lastError: this.lastError ?? null
    };
  }
  /** Every page open in the shared browser, for the preview tab strip. */
  get targets() {
    return this.lastTargets;
  }
  /**
   * Pin the preview to one page. Several Agent sessions share this browser,
   * so "follow the newest" alone makes the window jump between them.
   * `null` resumes following.
   */
  select(id) {
    this.selected = id ?? void 0;
    this.socket?.close();
    this.socket = void 0;
    this.targetUrl = void 0;
    if (this.selected === NO_TARGET || this.closed) return;
    void this.retarget();
  }
  async start() {
    if (WebSocketCtor === void 0) {
      this.lastError = "\u5F53\u524D Node \u7248\u672C\u7F3A\u5C11\u5168\u5C40 WebSocket";
      this.ctx.logger.warn(`browser-preview: ${this.lastError}`);
      return;
    }
    this.retargetTimer = setInterval(() => void this.retarget(), RETARGET_MS);
    this.captureTimer = setInterval(() => void this.capture(), Math.max(120, Math.round(1e3 / this.fps)));
    await this.retarget();
  }
  stop() {
    this.closed = true;
    if (this.retargetTimer !== void 0) clearInterval(this.retargetTimer);
    if (this.captureTimer !== void 0) clearInterval(this.captureTimer);
    this.retargetTimer = void 0;
    this.captureTimer = void 0;
    this.socket?.close();
    this.socket = void 0;
  }
  /** Follow the newest page target so an Agent opening a tab is what shows. */
  async retarget() {
    if (this.closed) return;
    let targets;
    try {
      targets = await listTargets(this.port);
    } catch (error) {
      this.lastError = `json/list: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    this.lastTargets = targets.filter((target) => target.type === "page").map((target) => ({ id: target.id, url: target.url, title: target.title ?? target.url }));
    if (this.selected === NO_TARGET) {
      this.socket?.close();
      this.socket = void 0;
      return;
    }
    const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl !== void 0);
    const pinned = this.selected === void 0 ? void 0 : pages.find((target) => target.id === this.selected);
    if (this.selected !== void 0 && pinned === void 0) this.selected = void 0;
    const page = pinned ?? [...pages].reverse().find((target) => target.url !== "about:blank") ?? pages[pages.length - 1];
    if (page?.webSocketDebuggerUrl === void 0) return;
    if (page.webSocketDebuggerUrl === this.targetUrl && this.connected) return;
    this.targetUrl = page.webSocketDebuggerUrl;
    this.socket?.close();
    this.attach(page.webSocketDebuggerUrl);
  }
  attach(url) {
    const socket = new WebSocketCtor(url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      void this.measure();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (pending === void 0) return;
      this.pending.delete(message.id);
      if (message.error !== void 0) pending.reject(new Error(String(message.error.message ?? "cdp error")));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = void 0;
    });
    socket.addEventListener("error", () => {
      this.lastError = "cdp websocket error";
      socket.close();
    });
  }
  /** Viewport size in CSS pixels, used to scale pointer input back. */
  async measure() {
    try {
      const metrics = await this.call("Page.getLayoutMetrics");
      const width = metrics?.cssVisualViewport?.width ?? metrics?.contentSize?.width;
      const height = metrics?.cssVisualViewport?.height ?? metrics?.contentSize?.height;
      if (typeof width === "number" && typeof height === "number") this.viewport = { width, height };
      this.lastError = void 0;
    } catch (error) {
      this.lastError = `getLayoutMetrics: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  async capture() {
    if (!this.connected || this.selected === NO_TARGET) return;
    try {
      const result = await this.call("Page.captureScreenshot", { format: "jpeg", quality: this.quality });
      const data = result?.data;
      if (typeof data !== "string") return;
      this.captured += 1;
      const frame = Buffer.from(data, "base64");
      if (this.lastFrame !== void 0 && this.lastFrame.equals(frame)) return;
      this.lastFrame = frame;
      this.frames += 1;
      this.onFrame(frame);
      this.lastError = void 0;
      this.timeouts = 0;
    } catch (error) {
      this.lastError = `captureScreenshot: ${error instanceof Error ? error.message : String(error)}`;
      this.timeouts += 1;
      if (this.timeouts >= 3) {
        this.timeouts = 0;
        this.socket?.close();
        this.socket = void 0;
      }
    }
  }
  /** Pointer/key input from the preview window, in 0..1 image space. */
  dispatch(payload) {
    if (!this.connected) return;
    const scaleX = this.viewport.width;
    const scaleY = this.viewport.height;
    switch (payload.t) {
      case "mouse": {
        const x = Math.round(Number(payload.x ?? 0) * scaleX);
        const y = Math.round(Number(payload.y ?? 0) * scaleY);
        void this.call("Input.dispatchMouseEvent", {
          type: String(payload.type ?? "mouseMoved"),
          x,
          y,
          button: payload.button === void 0 ? "none" : String(payload.button),
          clickCount: Number(payload.clickCount ?? 1),
          buttons: Number(payload.buttons ?? 0)
        }).catch(() => void 0);
        return;
      }
      case "wheel": {
        void this.call("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: Math.round(Number(payload.x ?? 0) * scaleX),
          y: Math.round(Number(payload.y ?? 0) * scaleY),
          deltaX: Number(payload.deltaX ?? 0),
          deltaY: Number(payload.deltaY ?? 0)
        }).catch(() => void 0);
        return;
      }
      case "text": {
        void this.call("Input.insertText", { text: String(payload.text ?? "") }).catch(() => void 0);
        return;
      }
      case "key": {
        const key = String(payload.key ?? "");
        void this.call("Input.dispatchKeyEvent", {
          type: String(payload.type ?? "keyDown"),
          key,
          code: String(payload.code ?? key),
          windowsVirtualKeyCode: Number(payload.keyCode ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 13))
        }).catch(() => void 0);
        return;
      }
      default:
        return;
    }
  }
  call(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error("cdp not connected"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.socket?.send(JSON.stringify({ id, method, params }));
    });
  }
};
function listTargets(port) {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path: "/json/list", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.setTimeout(3e3, () => req.destroy(new Error("json/list timeout")));
    req.on("error", reject);
  });
}

// src/proxy.ts
import { request as httpRequest } from "node:http";
import { connect as connect2 } from "node:net";
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization"
]);
function forwardHeaders(headers, port) {
  const out = { host: `127.0.0.1:${port}` };
  for (const [key, value] of Object.entries(headers)) {
    if (value === void 0) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "accept-encoding" || lower === "content-length") continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
async function proxyHttpRequest(req, res, port) {
  const target = req.url ?? "/";
  await new Promise((resolve) => {
    const upstream = httpRequest(
      { host: "127.0.0.1", port, path: target, method: req.method, headers: forwardHeaders(req.headers, port) },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on("end", resolve);
        upstreamRes.on("error", resolve);
      }
    );
    upstream.on("error", () => {
      if (res.headersSent) {
        res.destroy();
        resolve();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`browser-preview: noVNC upstream 127.0.0.1:${port} unreachable`);
      resolve();
    });
    req.pipe(upstream);
    req.on("error", () => {
      upstream.destroy();
      resolve();
    });
  });
}
function proxyWebSocket(req, socket, head, port) {
  const upstream = connect2(port, "127.0.0.1");
  const teardown = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", teardown);
  socket.on("error", teardown);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.on("connect", () => {
    const lines = [`GET ${NOVNC_UPSTREAM_WS_PATH} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    lines.push(`Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: websocket");
    upstream.write(`${lines.join("\r\n")}\r
\r
`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
}

// src/ws.ts
import { createHash } from "node:crypto";
var GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return false;
  }
  const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r
\r
`
  );
  return true;
}
function sendBinary(socket, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 130;
  socket.write(Buffer.concat([header, payload]));
}
function readTextFrames(socket, onText) {
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    for (; ; ) {
      if (pending.length < 2) return;
      const first = pending[0];
      const second = pending[1];
      const opcode = first & 15;
      const masked = (second & 128) !== 0;
      let length = second & 127;
      let offset = 2;
      if (length === 126) {
        if (pending.length < offset + 2) return;
        length = pending.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (pending.length < offset + 8) return;
        length = Number(pending.readBigUInt64BE(offset));
        offset += 8;
      }
      const maskKey = masked ? pending.subarray(offset, offset + 4) : void 0;
      if (maskKey !== void 0) offset += 4;
      if (pending.length < offset + length) return;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      pending = pending.subarray(offset + length);
      if (maskKey !== void 0) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      if (opcode === 1) onText(payload.toString("utf8"));
      else if (opcode === 8) socket.end();
      else if (opcode === 9) sendBinary(socket, payload);
    }
  });
}

// src/index.ts
var name = "browser-preview";
var DEP_OF = {
  Xvfb: "Xvfb",
  chromium: "chromium",
  x11vnc: "x11vnc",
  websockify: "websockify"
};
async function neededDeps(missing) {
  const deps = [];
  for (const name2 of missing) {
    const dep = DEP_OF[name2];
    if (dep !== void 0) deps.push(dep);
  }
  if (!await hasCjkFont()) deps.push("fonts");
  return deps;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}
function escapeHtml(value) {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}
async function readJsonBody(req, limit = 4096) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
var lastToolEvent = null;
var lastTargetRequest = null;
var lastEnvProbe = null;
function targetIdFromResult(result) {
  const blocks = result?.value?.content;
  if (!Array.isArray(blocks)) return void 0;
  for (const block of blocks) {
    const text = block?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.targetId === "string") return parsed.targetId;
    } catch {
    }
  }
  return void 0;
}
function renderViewerHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Agent \u6D4F\u89C8\u5668\u9884\u89C8</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden }
  img { width: 100%; height: 100%; object-fit: contain; display: block }
  #status { position: fixed; left: 10px; top: 10px; padding: 2px 8px; border-radius: 4px;
            background: rgba(0,0,0,.55); color: #9ca3af; font: 12px/1.6 system-ui, sans-serif }
</style>
<img id="view" alt="browser">
<div id="status">\u8FDE\u63A5\u4E2D\u2026</div>
<script>
  var img = document.getElementById('view')
  // named statusEl on purpose: window.status is a built-in string property,
  // so a global var named status would never reach the element
  var statusEl = document.getElementById('status')
  var socket = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + ${JSON.stringify(STREAM_PATH)})
  socket.binaryType = 'blob'
  socket.onopen = function () { statusEl.textContent = '\u5DF2\u8FDE\u63A5' }
  socket.onclose = function () { statusEl.textContent = '\u5DF2\u65AD\u5F00' }
  socket.onmessage = function (event) {
    if (typeof event.data === 'string') return
    statusEl.textContent = '\u5DF2\u8FDE\u63A5'
    var previous = img.dataset.url
    img.src = URL.createObjectURL(event.data)
    img.dataset.url = img.src
    if (previous) URL.revokeObjectURL(previous)
  }
  var send = function (payload) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload)) }
  var rel = function (event) {
    var rect = img.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }
  }
  img.onmousedown = function (e) { send({ t: 'mouse', type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...rel(e) }) }
  img.onmouseup = function (e) { send({ t: 'mouse', type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...rel(e) }) }
  img.onmousemove = function (e) { send({ t: 'mouse', type: 'mouseMoved', buttons: e.buttons, ...rel(e) }) }
  img.onwheel = function (e) { send({ t: 'wheel', deltaX: e.deltaX, deltaY: e.deltaY, ...rel(e) }) }
</script>`;
}
function apply(ctx, config) {
  const logger = ctx.logger("browser-preview");
  const stack = new BrowserStack(ctx, config);
  const viewers = /* @__PURE__ */ new Set();
  const sessionTargets = /* @__PURE__ */ new Map();
  const listSessions = () => [...sessionTargets].map(([sessionId, entry]) => ({ sessionId, targetId: entry.targetId }));
  const bridge = config.previewMode === "screencast" ? new ScreencastBridge(ctx, config.cdpPort, config.screencastFps, config.screencastQuality, (frame) => {
    for (const viewer of viewers) {
      try {
        sendBinary(viewer, frame);
      } catch {
        viewers.delete(viewer);
      }
    }
  }) : void 0;
  ctx.effect(() => async () => {
    bridge?.stop();
    for (const viewer of viewers) viewer.destroy();
    viewers.clear();
    await stack.stop({ keepBrowser: config.keepBrowser });
  }, "browser-preview: stack");
  ctx.on("tools/result", (exec, result) => {
    if (!exec.name.startsWith("mcp__browser__")) return;
    const sessionId = exec.agent?.session?.id;
    const targetId = targetIdFromResult(result) ?? (typeof exec.arguments?.targetId === "string" ? exec.arguments.targetId : void 0);
    lastToolEvent = {
      name: exec.name,
      hasAgent: exec.agent !== void 0 && exec.agent !== null,
      sessionId: typeof sessionId === "string" ? sessionId : null,
      targetId: targetId ?? null,
      at: Date.now()
    };
    if (typeof sessionId !== "string" || targetId === void 0) return;
    sessionTargets.set(sessionId, { targetId, at: Date.now() });
  });
  ctx.effect(
    () => ctx.inject(["webServer"], (web) => {
      web.effect(
        () => web.webServer.register({
          kind: "exact",
          path: STATUS_PATH,
          handler: async (_req, res) => {
            const live = new Set((bridge?.targets ?? []).map((target) => target.id));
            if (live.size > 0) {
              for (const [sessionId, entry] of sessionTargets) {
                if (Date.now() - entry.at < 1e4) continue;
                if (!live.has(entry.targetId)) sessionTargets.delete(sessionId);
              }
            }
            sendJson(res, 200, {
              ...stack.snapshot,
              targets: bridge?.targets ?? [],
              sessions: listSessions(),
              selected: bridge?.diagnostics?.selected ?? null,
              viewers: viewers.size,
              stream: bridge?.diagnostics ?? null,
              platform: platformInfo(),
              dependencies: lastEnvProbe,
              diagnostics: { lastToolEvent, lastTargetRequest }
            });
          }
        }),
        `browser-preview: GET ${STATUS_PATH}`
      );
      web.effect(
        () => web.webServer.register({
          kind: "exact",
          path: TARGET_PATH,
          handler: async (req, res) => {
            if (req.method === "GET") {
              sendJson(res, 200, {
                targets: bridge?.targets ?? [],
                sessions: listSessions(),
                selected: bridge?.diagnostics?.selected ?? null
              });
              return;
            }
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "POST { id } expected" });
              return;
            }
            const body = await readJsonBody(req);
            if (typeof body?.session === "string") {
              const id2 = sessionTargets.get(body.session)?.targetId ?? NO_TARGET;
              bridge?.select(id2);
              lastTargetRequest = { kind: "session", session: body.session, resolved: id2, at: Date.now() };
              sendJson(res, 200, { session: body.session, selected: id2 });
              return;
            }
            const id = typeof body?.id === "string" ? body.id : null;
            bridge?.select(id);
            lastTargetRequest = { kind: "id", id, at: Date.now() };
            sendJson(res, 200, { selected: id });
          }
        }),
        `browser-preview: ${TARGET_PATH}`
      );
      web.effect(
        () => web.webServer.register({
          kind: "exact",
          path: DEPS_PATH,
          handler: async (req, res) => {
            if (req.method === "GET") {
              const items = await probeEnvironment({
                vnc: config.vnc,
                novncWebRoot: config.novncWebRoot,
                chromiumBin: config.chromiumBin
              });
              const missing = items.filter((item) => item.needed && !item.ok).map((item) => item.id);
              lastEnvProbe = { items, missing, at: Date.now() };
              sendJson(res, 200, {
                ...platformInfo(),
                ready: missing.length === 0,
                items,
                missing,
                deps: missing
              });
              return;
            }
            if (req.method !== "POST") {
              sendJson(res, 405, { error: "GET \u63A2\u6D4B\u4F9D\u8D56\uFF0CPOST \u5B89\u88C5\u4F9D\u8D56" });
              return;
            }
            if (installing) {
              sendJson(res, 409, { error: "\u5B89\u88C5\u8FDB\u884C\u4E2D" });
              return;
            }
            const body = await readJsonBody(req);
            const requested = Array.isArray(body?.deps) ? body.deps.filter((dep) => typeof dep === "string") : await neededDeps(stack.snapshot.missing);
            installing = true;
            try {
              const report = await installDeps(requested, config.installTimeoutMs);
              await stack.start();
              sendJson(res, 200, { ...report, ready: stack.snapshot.ready });
            } finally {
              installing = false;
            }
          }
        }),
        `browser-preview: ${DEPS_PATH}`
      );
      web.effect(
        () => web.webServer.register({
          kind: "exact",
          path: VIEW_PATH,
          handler: async (_req, res) => {
            if (config.previewMode === "vnc") {
              res.writeHead(302, {
                location: `${ROUTE_PREFIX}/vnc.html?path=${encodeURIComponent(WS_PATH)}&autoconnect=true&resize=scale`
              });
              res.end();
              return;
            }
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.end(renderViewerHtml());
          }
        }),
        `browser-preview: GET ${VIEW_PATH}`
      );
      web.effect(
        () => web.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            const snapshot = stack.snapshot;
            if (config.previewMode !== "vnc") {
              sendJson(res, 404, { error: "vnc preview disabled; use /browser-preview/stream" });
              return;
            }
            if (!snapshot.ready) {
              const hint = snapshot.message ?? "\u6D4F\u89C8\u5668\u6808\u5C1A\u672A\u5C31\u7EEA";
              res.writeHead(503, { "content-type": "text/html; charset=utf-8" });
              res.end(
                `<!doctype html><meta charset="utf-8"><title>Browser Preview</title><div style="font:14px/1.6 system-ui;padding:24px;color:#ddd;background:#151515;min-height:100vh"><h2 style="margin:0 0 8px">\u6D4F\u89C8\u5668\u9884\u89C8\u672A\u5C31\u7EEA</h2><p style="color:#f87171">${escapeHtml(hint)}</p><pre style="white-space:pre-wrap;color:#9ca3af">apt install -y xvfb chromium x11vnc novnc websockify</pre></div>`
              );
              return;
            }
            await proxyHttpRequest(req, res, config.novncPort);
          }
        }),
        `browser-preview: ${ROUTE_PREFIX}/*`
      );
      web.effect(
        () => web.webServer.registerUpgrade({
          path: WS_PATH,
          handler: (req, socket, head) => {
            proxyWebSocket(req, socket, head, config.novncPort);
          }
        }),
        `browser-preview: ${WS_PATH} (websocket)`
      );
      web.effect(
        () => web.webServer.registerUpgrade({
          path: STREAM_PATH,
          handler: (req, socket, head) => {
            if (!acceptWebSocket(req, socket)) return;
            viewers.add(socket);
            const latest = bridge?.currentFrame;
            if (latest !== void 0) sendBinary(socket, latest);
            socket.on("close", () => viewers.delete(socket));
            socket.on("error", () => viewers.delete(socket));
            readTextFrames(socket, (text) => {
              try {
                bridge?.dispatch(JSON.parse(text));
              } catch {
              }
            });
            if (head.length > 0) socket.emit("data", head);
          }
        }),
        `browser-preview: ${STREAM_PATH} (screencast)`
      );
    }).dispose,
    "browser-preview: webServer routes"
  );
  let installing = false;
  const boot = async () => {
    await stack.start();
    if (config.autoInstall === "on-start" && stack.snapshot.missing.length > 0) {
      installing = true;
      try {
        const report = await installDeps(await neededDeps(stack.snapshot.missing), config.installTimeoutMs);
        logger.info(
          `browser-preview: \u81EA\u52A8\u5B89\u88C5\u5B8C\u6210\uFF08\u6210\u529F ${report.installed.join(",") || "\u65E0"}\uFF1B\u5931\u8D25 ${report.failed.join(",") || "\u65E0"}\uFF09`
        );
      } finally {
        installing = false;
      }
      await stack.start();
    }
    await bridge?.start();
  };
  if (config.autoStart) {
    void boot().catch((error) => {
      logger.warn(error instanceof Error ? error : new Error(String(error)));
    });
  }
  ctx.logger.info(`browser-preview: routes mounted at ${ROUTE_PREFIX} (ws ${WS_PATH} \u2192 ${NOVNC_UPSTREAM_WS_PATH})`);
}
export {
  Config,
  apply,
  name
};
//# sourceMappingURL=index.js.map
