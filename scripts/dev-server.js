#!/usr/bin/env node
// ============================================================================
// STRYV frontend dev server
// ============================================================================
// WHY THIS EXISTS
// `npm run dev` is `tauri dev`, which shells out to `cargo metadata`. This
// machine has no Rust toolchain and no MSVC, so that command cannot work. That
// leaves no way to see a frontend change without a full CI production build.
//
// This server closes that gap for everything that is NOT Rust:
//
//   - serves the real files out of src/ - not a copy, not a bundle
//   - injects scripts/dev/mock-backend.js so the app boots without Tauri
//   - reloads the page the instant a file under src/ changes
//   - sends no-store, so a reload always gets the file you just saved
//
// WHAT IT IS NOT
//   - It is not the app. There is no Rust process, no real hardware reading,
//     no updater, no signing. The mock badge says so on screen.
//   - It does not fake a successful build. If you changed Rust, you have not
//     tested your change here.
//
// USAGE
//   node scripts/dev-server.js            # http://localhost:5173
//   node scripts/dev-server.js --port 6000
//   node scripts/dev-server.js --no-reload
// ============================================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MOCK = path.join(__dirname, "dev", "mock-backend.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = parseInt(flag("--port", process.env.STRYV_DEV_PORT || "5173"), 10);
const RELOAD = !args.includes("--no-reload");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// ---------------------------------------------------------------------------
// Reload clients
// ---------------------------------------------------------------------------
const clients = new Set();

function broadcast(file) {
  const payload = `data: ${JSON.stringify({ file, at: Date.now() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
  if (clients.size) console.log(`  reload -> ${clients.size} client(s)  (${path.relative(ROOT, file)})`);
}

// Watch src/ recursively. Debounced, because editors write in bursts and a
// partial write would otherwise be served as a syntax error.
let timer = null;
const touched = new Set();
function onChange(file) {
  touched.add(file);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const files = [...touched];
    touched.clear();
    const first = files[0];
    if (first.endsWith(".html") || files.some((f) => /index\.html$/.test(f))) reloadAll();
    else broadcast(path.relative(ROOT, first));
  }, 90);
}

function watch(dir) {
  let watcher;
  try {
    watcher = fs.watch(dir, { recursive: true }, (ev, name) => {
      if (!name) return;
      const full = path.join(dir, name);
      if (/\.(tmp|swp|~)$/.test(name)) return;
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return;
      onChange(full);
    });
  } catch (e) {
    console.warn("  watch failed on " + dir + ": " + e.message);
    return null;
  }
  watcher.on("error", (e) => console.warn("  watcher error: " + e.message));
  return watcher;
}

// Windows: fs.watch recursive is unreliable on some network/OneDrive paths.
// OneDrive is exactly that case - the repo lives under OneDrive\Desktop - so
// fall back to polling. Slower to notice, but it does notice.
function watchFallback(dir, intervalMs = 700) {
  const snap = new Map();
  const scan = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) scan(full);
      else {
        const m = fs.statSync(full).mtimeMs;
        if (snap.has(full) && snap.get(full) !== m) onChange(full);
        snap.set(full, m);
      }
    }
  };
  scan(dir);
  const id = setInterval(() => scan(dir), intervalMs);
  id.unref && id.unref();
  return id;
}

function reloadAll() {
  for (const res of clients) {
    try { res.write(`data: ${JSON.stringify({ reload: true, at: Date.now() })}\n\n`); } catch { clients.delete(res); }
  }
  if (clients.size) console.log(`  full reload -> ${clients.size} client(s)`);
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------
// The mock and the reload client are injected into the page THIS SERVER
// SERVES. src/index.html is never modified on disk, so the shipped frontend has
// no reference to either of them. That is the guarantee that dev-only behaviour
// cannot reach a production build: there is nothing to reach it with.
const RELOAD_CLIENT = `
<script>
(function () {
  var es = new EventSource("/__dev/reload");
  es.onmessage = function (e) {
    var d = JSON.parse(e.data);
    // A stylesheet swap is instant and keeps scroll position; anything else is
    // a real reload, because these are classic scripts sharing globals and
    // there is no module graph to hot-swap into.
    if (!d.reload && /\\.css$/.test(d.file || "")) {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var s = document.styleSheets[i];
        if (s.href && /style\\.css/.test(s.href)) {
          s.href = s.href.split("?")[0] + "?r=" + d.at;
          return;
        }
      }
    }
    location.reload();
  };
  es.onerror = function () { /* dev server restarted; the browser retries */ };
})();
</script>
`;

function inject(html) {
  const head = html.match(/<head[^>]*>/i);
  if (!head) return html;
  const at = head.index + head[0].length;
  const block =
    `\n<script src="/__dev/mock.js"></script>` +
    RELOAD_CLIENT +
    `\n<meta name="stryv-dev" content="1">\n`;
  return html.slice(0, at) + block + html.slice(at);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || "/");

  // --- dev-only endpoints ---
  if (pathname === "/__dev/reload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25000);
    ka.unref && ka.unref();
    req.on("close", () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  if (pathname === "/__dev/mock.js") {
    const body = fs.readFileSync(MOCK);
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  if (pathname === "/__dev/status") {
    res.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "no-store" });
    res.end(JSON.stringify({
      ok: true, root: SRC, reload: RELOAD, clients: clients.size,
      rust: rustPresent(), note: "frontend only - no Tauri, no Rust, synthetic data",
    }, null, 2));
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  // Contain the served path inside src/. A dev server that can read the whole
  // disk is a dev server that eventually serves the signing key.
  const target = path.join(SRC, path.normalize(pathname).replace(/^([/\\])+/, ""));
  if (!target.startsWith(SRC)) {
    res.writeHead(403); res.end("Forbidden");
    return;
  }

  fs.readFile(target, (err, buf) => {
    if (err) {
      const missing = path.extname(target);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 " + pathname + (missing ? "" : " - did you mean a script tag with a typo?"));
      return;
    }
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html") {
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      res.end(inject(buf.toString("utf8")));
      return;
    }
    // no-store everywhere: a 304 from the OS cache is how you end up staring at
    // yesterday's smoke while believing you are iterating.
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});

function rustPresent() {
  const candidates = [
    path.join(process.env.USERPROFILE || "", ".cargo", "bin", "cargo.exe"),
    path.join(ROOT, "node_modules", ".bin", "cargo.exe"),
  ];
  return candidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  STRYV frontend dev server");
  console.log("  " + "-".repeat(52));
  console.log("  url     http://localhost:" + PORT);
  console.log("  serving " + SRC);
  console.log("  reload  " + (RELOAD ? "on (SSE)" : "off"));
  console.log("  rust    " + (rustPresent() ? "found" : "NOT INSTALLED - this server is frontend only"));
  console.log("");
  console.log("  This is not the desktop app. Readings are synthetic and the");
  console.log("  window, updater and signing do not exist here. To run the real");
  console.log("  app you need Rust: npm run dev:setup  (once), then npm run dev:app.");
  console.log("");
});

if (RELOAD) {
  const w = watch(SRC);
  if (!w) watchFallback(SRC);
  else {
    // Even with a working recursive watch, arm the poller at a slow cadence as
    // a safety net. OneDrive can swallow events.
    watchFallback(SRC, 1500);
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { console.log("\n  dev server stopped"); process.exit(0); });
}
