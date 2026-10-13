// Classic (non-module) script, loaded before main.js so it also catches syntax/import errors:
// shows the failure on the loading screen instead of hanging at 0%.
// On the local dev server (port 5181, e.g. a phone on the Wi-Fi), it also reports errors and loading stages to
// it (tools/serve.py prints them), since phones have no console to read: window.__devlog(kind, data).
(() => {
  const dev = location.port === "5181";
  const t0 = performance.now();
  const devlog = (window.__devlog = (kind, data = {}) => {
    if (!dev) return;
    const body = JSON.stringify({ kind, t: Math.round(performance.now() - t0), ...data });
    try {
      fetch("/__log", { method: "POST", body, keepalive: true }).catch(() => {});
    } catch {}
  });
  const fail = (msg) => {
    const el = document.querySelector(".loader");
    if (!el || el.classList.contains("done") || el.dataset.failed) return;
    el.dataset.failed = "1";
    el.innerHTML = '<span class="pct">Couldn’t load the scene</span><p style="max-width:420px;font-size:12px;color:#8f897c;text-align:center"></p>';
    el.querySelector("p").textContent = msg;
  };
  // Only the site's own scripts count: browsers and extensions inject their own (Brave's wallet, for one),
  // whose errors arrive here too, as "Script error." or from the page itself, and must not stop the loading.
  // (A real failure in the scene's code also rejects main.js's promises: see unhandledrejection.)
  const ours = (file) => !!file && file.startsWith(location.origin) && /\.js(\?|$)/.test(file);
  addEventListener("error", (e) => {
    devlog("error", { message: e.message, file: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack, ours: ours(e.filename) });
    if (ours(e.filename)) fail(e.message);
  });
  addEventListener("unhandledrejection", (e) => {
    const stack = String(e.reason?.stack ?? ""), mine = stack.includes(location.origin) || stack.includes("cdn.jsdelivr.net/npm/three");
    devlog("rejection", { message: e.reason?.message ?? String(e.reason), stack, ours: mine });
    if (mine) fail(e.reason?.message ?? String(e.reason));
  });
  if (dev) {
    const c = document.createElement("canvas"), gl = c.getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    devlog("start", {
      ua: navigator.userAgent, screen: `${innerWidth}x${innerHeight}@${devicePixelRatio}`, webgl2: !!gl,
      gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, maxTexture: gl?.getParameter(gl.MAX_TEXTURE_SIZE),
      memory: navigator.deviceMemory, cores: navigator.hardwareConcurrency,
    });
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    addEventListener("pagehide", () => devlog("pagehide"));
  }
})();
