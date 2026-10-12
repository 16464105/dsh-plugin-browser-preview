window.__ModuleLoader__.load({
	id: "dsh-plugin-browser-preview",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.tsx
var index_exports = {};
__export(index_exports, {
  ROUTE_PREFIX: () => ROUTE_PREFIX,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var import_react = require("react");

// src/shared.ts
var ROUTE_PREFIX = "/browser-preview";
var STATUS_PATH = `${ROUTE_PREFIX}/api/status`;
var WS_PATH = `${ROUTE_PREFIX}/ws`;
var STREAM_PATH = `${ROUTE_PREFIX}/stream`;
var VIEW_PATH = `${ROUTE_PREFIX}/view`;
var NOVNC_ENTRY_PATH = `${ROUTE_PREFIX}/vnc.html`;
var TARGET_PATH = `${ROUTE_PREFIX}/api/target`;
var DEPS_PATH = `${ROUTE_PREFIX}/api/deps`;
var NO_TARGET = "";

// src/client/index.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var inject = ["slots", "sessions", "uiSession"];
var currentSession = null;
var sessionListeners = /* @__PURE__ */ new Set();
var sessionTitles = /* @__PURE__ */ new Map();
function publishSession(next) {
  if (currentSession?.id === next?.id && currentSession?.title === next?.title) return;
  currentSession = next;
  window.__dshBrowserPreview = {
    session: next
  };
  for (const listener of sessionListeners) listener();
}
var subscribeSession = (listener) => {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
};
var readSession = () => currentSession;
var BUILD_ID = true ? "0.1.0+8ed449d" : "dev";
var POLL_MS = 3e3;
var PANEL_WIDTH = 960;
var PANEL_HEIGHT = 600;
var novncUrl = new URL(NOVNC_ENTRY_PATH, "http://localhost");
novncUrl.searchParams.set("path", WS_PATH);
novncUrl.searchParams.set("autoconnect", "true");
novncUrl.searchParams.set("resize", "scale");
novncUrl.searchParams.set("reconnect", "true");
novncUrl.searchParams.set("reconnect_delay", "2000");
novncUrl.searchParams.set("show_dot", "true");
var NOVNC_SRC = `${novncUrl.pathname}${novncUrl.search}`;
function chipStyle(active) {
  return {
    border: `1px solid ${active ? "#2563eb" : "rgba(255,255,255,0.12)"}`,
    background: active ? "rgba(37,99,235,0.25)" : "transparent",
    color: active ? "#dbeafe" : "#9ca3af",
    borderRadius: 4,
    padding: "1px 6px",
    fontSize: 11,
    cursor: "pointer",
    whiteSpace: "nowrap",
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis"
  };
}
var styles = {
  tabs: {
    display: "flex",
    gap: 4,
    padding: "4px 8px",
    background: "#1c1c1c",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    overflowX: "auto",
    flex: "0 0 auto"
  },
  launcher: {
    position: "fixed",
    right: 24,
    bottom: 24,
    width: 44,
    height: 44,
    borderRadius: "50%",
    border: "1px solid rgba(255,255,255,0.16)",
    background: "#2563eb",
    color: "#fff",
    fontSize: 18,
    lineHeight: "42px",
    textAlign: "center",
    cursor: "pointer",
    boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
    pointerEvents: "auto"
  },
  panel: {
    position: "fixed",
    right: 24,
    bottom: 84,
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    minWidth: 420,
    minHeight: 320,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    resize: "both",
    border: "1px solid rgba(255,255,255,0.14)",
    borderRadius: 10,
    background: "#151515",
    boxShadow: "0 18px 48px rgba(0,0,0,0.45)",
    pointerEvents: "auto"
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    background: "#242424",
    color: "#e5e7eb",
    fontSize: 12,
    cursor: "move",
    userSelect: "none",
    flex: "0 0 auto"
  },
  iframe: { flex: "1 1 auto", width: "100%", border: "none", background: "#000" },
  ghost: {
    flex: "1 1 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    textAlign: "center",
    color: "#9ca3af",
    fontSize: 13,
    lineHeight: 1.7
  },
  iconButton: {
    border: "none",
    background: "transparent",
    color: "#e5e7eb",
    cursor: "pointer",
    fontSize: 14,
    padding: "0 4px"
  }
};
function stateText(snapshot, offline) {
  if (offline) return "\u{1F7E1} \u63D2\u4EF6\u672A\u8FDE\u63A5";
  if (snapshot === null) return "\u23F3 \u68C0\u67E5\u4E2D\u2026";
  return snapshot.ready ? `\u{1F7E2} \u5C31\u7EEA \xB7 CDP ${snapshot.cdpPort}` : `\u{1F534} ${snapshot.message ?? "\u672A\u5C31\u7EEA"}`;
}
function ScreencastView() {
  const socketRef = (0, import_react.useRef)(null);
  const [frameUrl, setFrameUrl] = (0, import_react.useState)(null);
  const [live, setLive] = (0, import_react.useState)(false);
  (0, import_react.useEffect)(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}${STREAM_PATH}`);
    socketRef.current = socket;
    socket.binaryType = "blob";
    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socket.onerror = () => setLive(false);
    socket.onmessage = (event) => {
      if (typeof event.data === "string") return;
      setFrameUrl(URL.createObjectURL(event.data));
    };
    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);
  (0, import_react.useEffect)(() => {
    if (frameUrl === null) return;
    return () => URL.revokeObjectURL(frameUrl);
  }, [frameUrl]);
  const send = (payload) => {
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };
  const relative = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.iframe, children: frameUrl === null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.ghost, children: live ? "\u7B49\u5F85\u753B\u9762\u2026" : "\u753B\u9762\u6D41\u672A\u8FDE\u63A5" }) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "img",
    {
      src: frameUrl,
      alt: "Agent browser",
      draggable: false,
      style: { width: "100%", height: "100%", objectFit: "contain", background: "#000" },
      onMouseDown: (event) => send({ t: "mouse", type: "mousePressed", button: "left", buttons: 1, clickCount: 1, ...relative(event) }),
      onMouseUp: (event) => send({ t: "mouse", type: "mouseReleased", button: "left", buttons: 0, clickCount: 1, ...relative(event) }),
      onMouseMove: (event) => send({ t: "mouse", type: "mouseMoved", buttons: event.buttons, ...relative(event) }),
      onWheel: (event) => send({ t: "wheel", deltaX: event.deltaX, deltaY: event.deltaY, ...relative(event) })
    }
  ) });
}
function BrowserPreviewWindow() {
  const [open, setOpen] = (0, import_react.useState)(false);
  const [snapshot, setSnapshot] = (0, import_react.useState)(null);
  const [offline, setOffline] = (0, import_react.useState)(false);
  const [position, setPosition] = (0, import_react.useState)(null);
  const panelRef = (0, import_react.useRef)(null);
  const dragRef = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setSnapshot(data);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const selectTarget = (0, import_react.useCallback)(async (id) => {
    try {
      await fetch(TARGET_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id })
      });
      const res = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
      if (res.ok) setSnapshot(await res.json());
    } catch {
    }
  }, []);
  const selectSession = (0, import_react.useCallback)(async (sessionId) => {
    try {
      await fetch(TARGET_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: sessionId })
      });
      const res = await fetch(STATUS_PATH, { headers: { accept: "application/json" } });
      if (res.ok) setSnapshot(await res.json());
    } catch {
    }
  }, []);
  const onPointerDown = (0, import_react.useCallback)((event) => {
    if (event.target.closest("button, a") !== null) return;
    const el = panelRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);
  const stopDrag = (0, import_react.useCallback)((event) => {
    event.stopPropagation();
  }, []);
  const onPointerMove = (0, import_react.useCallback)((event) => {
    const drag = dragRef.current;
    if (drag === null) return;
    setPosition({
      left: Math.max(0, Math.min(event.clientX - drag.dx, window.innerWidth - 80)),
      top: Math.max(0, Math.min(event.clientY - drag.dy, window.innerHeight - 40))
    });
  }, []);
  const onPointerUp = (0, import_react.useCallback)((event) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  const current = (0, import_react.useSyncExternalStore)(subscribeSession, readSession);
  const [follow, setFollow] = (0, import_react.useState)(true);
  (0, import_react.useEffect)(() => {
    if (!follow || current === null) return;
    void selectSession(current.id);
  }, [follow, current?.id, selectSession]);
  (0, import_react.useEffect)(() => {
    if (!follow || current === null || snapshot === null) return;
    const binding = snapshot.sessions.find((entry) => entry.sessionId === current.id);
    if (binding === void 0 || snapshot.selected === binding.targetId) return;
    void selectSession(current.id);
  }, [follow, current?.id, snapshot?.selected, snapshot?.sessions, selectSession]);
  const [installing, setInstalling] = (0, import_react.useState)(false);
  const [installNote, setInstallNote] = (0, import_react.useState)(null);
  const runInstall = (0, import_react.useCallback)(async () => {
    setInstalling(true);
    setInstallNote(null);
    try {
      const res = await fetch(DEPS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      });
      const report = await res.json();
      if (typeof report.error === "string") {
        setInstallNote(report.error);
        return;
      }
      const done = report.installed?.join("\u3001") ?? "\u65E0";
      const failed = report.failed?.length ? `\uFF1B\u5931\u8D25\uFF1A${report.failed?.join("\u3001")}` : "";
      setInstallNote(`\u5DF2\u5B89\u88C5 ${done}${failed}`);
    } catch {
      setInstallNote("\u5B89\u88C5\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u67E5\u770B DSH \u65E5\u5FD7");
    } finally {
      setInstalling(false);
    }
  }, []);
  const ready = snapshot?.ready === true;
  const [reloadKey, setReloadKey] = (0, import_react.useState)(0);
  const openHref = snapshot?.previewMode === "vnc" ? NOVNC_SRC : VIEW_PATH;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "div",
      {
        style: styles.launcher,
        role: "button",
        tabIndex: 0,
        title: "Agent \u6D4F\u89C8\u5668\u9884\u89C8",
        onClick: () => setOpen((value) => !value),
        onKeyDown: (event) => {
          if (event.key === "Enter" || event.key === " ") setOpen((value) => !value);
        },
        children: "\u{1F5A5}\uFE0F"
      }
    ),
    open ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "div",
      {
        ref: panelRef,
        style: position === null ? styles.panel : { ...styles.panel, left: position.left, top: position.top, right: "auto", bottom: "auto" },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.header, onPointerDown, onPointerMove, onPointerUp, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: "Agent \u6D4F\u89C8\u5668\u9884\u89C8" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { opacity: 0.75 }, children: stateText(snapshot, offline) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: { fontSize: 10, opacity: 0.45 }, title: "\u5BA2\u6237\u7AEF\u6784\u5EFA\u7248\u672C", children: BUILD_ID }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: { marginLeft: "auto", display: "flex", gap: 4 }, children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  style: styles.iconButton,
                  title: "\u91CD\u65B0\u8FDE\u63A5",
                  onPointerDown: stopDrag,
                  onClick: () => setReloadKey((value) => value + 1),
                  children: "\u27F3"
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "a",
                {
                  href: openHref,
                  target: "_blank",
                  rel: "noreferrer",
                  style: { ...styles.iconButton, textDecoration: "none" },
                  title: "\u65B0\u6807\u7B7E\u6253\u5F00",
                  onPointerDown: stopDrag,
                  children: "\u2197"
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                "button",
                {
                  type: "button",
                  style: styles.iconButton,
                  title: "\u5173\u95ED",
                  onPointerDown: stopDrag,
                  onClick: () => setOpen(false),
                  children: "\u2715"
                }
              )
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: styles.tabs, children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
              "button",
              {
                type: "button",
                style: chipStyle(follow),
                title: follow ? "\u5207\u6362\u4F1A\u8BDD\u65F6\u81EA\u52A8\u663E\u793A\u8BE5\u4F1A\u8BDD\u6253\u5F00\u7684\u9875\u9762\uFF08\u70B9\u51FB\u5173\u95ED\uFF09" : "\u624B\u52A8\u9009\u62E9\u8981\u9884\u89C8\u7684\u4F1A\u8BDD\uFF08\u70B9\u51FB\u5F00\u542F\u81EA\u52A8\u8DDF\u968F\uFF09",
                onClick: () => setFollow((value) => !value),
                children: "\u8DDF\u968F\u4F1A\u8BDD"
              }
            ),
            (snapshot?.sessions ?? []).map((entry) => {
              const page = snapshot?.targets.find((target) => target.id === entry.targetId);
              return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
                "button",
                {
                  type: "button",
                  style: chipStyle(snapshot?.selected === entry.targetId),
                  title: `${sessionTitles.get(entry.sessionId) ?? entry.sessionId} \u2014 ${page?.url ?? "\u9875\u9762\u5DF2\u5173\u95ED"}`,
                  onClick: () => void selectSession(entry.sessionId),
                  children: [
                    sessionTitles.get(entry.sessionId) ?? entry.sessionId.slice(0, 8),
                    current?.id === entry.sessionId ? " \u25CF" : ""
                  ]
                },
                entry.sessionId
              );
            })
          ] }),
          !ready ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.ghost, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: stateText(snapshot, offline) }),
            snapshot !== null && snapshot.missing.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8 }, children: [
              "\u7F3A\u5C11\uFF1A",
              snapshot.missing.join("\u3001"),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("code", { children: snapshot.platform?.manager === "apt" ? "apt install -y xvfb chromium x11vnc novnc websockify" : "dnf install -y xorg-x11-server-Xvfb chromium x11vnc novnc python3-websockify" }),
              snapshot.platform !== null && snapshot.platform !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: { marginTop: 8 }, children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
                  "button",
                  {
                    type: "button",
                    style: { ...chipStyle(false), padding: "3px 10px", fontSize: 12 },
                    disabled: installing,
                    onClick: () => void runInstall(),
                    children: installing ? "\u5B89\u88C5\u4E2D\u2026" : `\u4E00\u952E\u5B89\u88C5\uFF08${snapshot.platform.manager}\uFF09`
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 4, opacity: 0.7 }, children: snapshot.platform.root ? "\u4EE5 root \u76F4\u63A5\u5B89\u88C5" : "\u5C06\u901A\u8FC7 sudo -n \u5B89\u88C5\uFF08\u9700\u514D\u5BC6 sudo\uFF09" })
              ] }) : null,
              installNote !== null ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 6 }, children: installNote }) : null
            ] }) : null
          ] }) }) : snapshot?.selected === NO_TARGET ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: styles.ghost, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: "\u5F53\u524D\u4F1A\u8BDD\u8FD8\u6CA1\u6709\u6253\u5F00\u9875\u9762" }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: { marginTop: 8, opacity: 0.7 }, children: "\u8BA9 Agent \u7528\u6D4F\u89C8\u5668\u5DE5\u5177\u6253\u5F00\u4E00\u4E2A\u9875\u9762\uFF0C\u753B\u9762\u4F1A\u81EA\u52A8\u51FA\u73B0\u5728\u8FD9\u91CC" })
          ] }) }) : snapshot?.previewMode === "vnc" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            "iframe",
            {
              style: styles.iframe,
              src: NOVNC_SRC,
              title: "Agent browser preview",
              sandbox: "allow-scripts allow-same-origin allow-forms allow-popups"
            },
            reloadKey
          ) : (
            // remount on reload: the ⟳ button restarts the frame stream
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScreencastView, {}, reloadKey)
          )
        ]
      }
    ) : null
  ] });
}
function apply(ctx) {
  ctx.effect(() => {
    const read = () => {
      const id = ctx.uiSession.adapter.current.getSnapshot().key;
      if (id === void 0) return null;
      const rows = Object.values(ctx.sessions.list.getSnapshot().byId);
      for (const row of rows) if (row.displayTitle !== void 0) sessionTitles.set(row.id, row.displayTitle);
      const summary = rows.find((row) => row.id === id);
      return { id, title: summary?.displayTitle ?? id };
    };
    const sync = () => publishSession(read());
    const offCurrent = ctx.uiSession.adapter.current.subscribe(sync);
    const offList = ctx.sessions.list.subscribe(sync);
    sync();
    return () => {
      offCurrent();
      offList();
      publishSession(null);
    };
  }, "browser-preview: current session");
  ctx.slots.inject(
    "shell.overlay",
    () => ctx.slots.register(
      {
        name: "shell.overlay",
        id: "browser-preview",
        order: 100,
        label: () => "Browser Preview"
      },
      BrowserPreviewWindow
    )
  );
}

		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
