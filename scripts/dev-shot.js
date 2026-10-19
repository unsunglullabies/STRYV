#!/usr/bin/env node
// ============================================================================
// STRYV dev screenshot helper
// ============================================================================
// WHY THIS EXISTS AND WHY IT IS WRITTEN THIS WAY
//
// 1. Headless Chromium does not reliably exit when a page holds a connection
//    open, and the dev page keeps a live-reload EventSource open forever. So
//    this serves the same src/ files WITH the mock backend but WITHOUT the
//    reload client. Nothing stays connected and the browser exits on its own.
//
// 2. The browser MUST be spawned asynchronously. spawnSync blocks Node's event
//    loop for the browser's entire lifetime, so the http server below accepts
//    connections and never answers them: the document never loads, virtual
//    time never completes, and the tool writes a blank PNG and exits 0. That
//    bug shipped, and every screenshot taken through it was worthless while
//    reporting success.
//
// 3. A PNG existing is not evidence that anything rendered. A blank page
//    compresses to a few KB, so a size floor is enforced before success.
//
// USAGE
//   node scripts/dev-shot.js --out shot.png
//   node scripts/dev-shot.js --out shot.png --size 1600x900 --page aery
//   node scripts/dev-shot.js --out shot.png --at 1200     (pinned clock)
//   node scripts/dev-shot.js --out shot.png --no-intro
// ============================================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MOCK = path.join(__dirname, "dev", "mock-backend.js");

// The mock runs in a browser and cannot require() anything, so the real release
// notes are generated here and injected as globals. Generated from the same
// script that writes latest.json, so what a dev shot shows is what ships.
function updateSeed() {
  let version = "0.0.0";
  let notes = "";
  try {
    version = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
    notes = require("child_process")
      .execFileSync(process.execPath, [path.join(__dirname, "release-notes.js"), "--short"], { encoding: "utf8" });
  } catch (e) {
    notes = "";
  }
  return `<script>
  window.__DEV_UPDATE_VERSION__ = ${JSON.stringify(version)};
  window.__DEV_UPDATE_NOTES__ = ${JSON.stringify(notes)};
  </script>`;
}

const BRAVE_CANDIDATES = [
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const OUT = path.resolve(flag("--out", "shot.png"));
const [W, H] = flag("--size", "1280x800").split("x").map(Number);
const AT = flag("--at", "");
const PAGE = flag("--page", "");
const NO_INTRO = has("--no-intro");
const BUDGET = parseInt(flag("--budget", "6000"), 10);
const MIN_BYTES = parseInt(flag("--min-bytes", "8192"), 10);

const browser = BRAVE_CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) {
  console.error("  no Chromium-based browser found; tried:");
  BRAVE_CANDIDATES.forEach((p) => console.error("    " + p));
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
};

const NO_INTRO_SEED = `<script>
try { var s = JSON.parse(localStorage.getItem("stryv.settings") || "{}"); s.intro = false;
      localStorage.setItem("stryv.settings", JSON.stringify(s)); } catch (e) {}
</script>`;

const PINNED_CLOCK = `<script>
(function () {
  var vt = 0, queue = [], err = null;
  Object.defineProperty(performance, "now", { value: function () { return vt; } });
  window.requestAnimationFrame = function (cb) { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = function () {};
  window.addEventListener("error", function (e) { err = e.message; });
  window.__pinned = {
    steps: ${AT ? parseInt(AT, 10) : (NO_INTRO ? 260 : 0)},
    run: function () { for (var i = 0; i < this.steps; i++) { vt += 16;
      var b = queue.splice(0, queue.length);
      for (var j = 0; j < b.length; j++) { try { b[j](vt); } catch (e) { err = e.message; } } } },
    err: function () { return err; }
  };
})();
</script>`;

const HARNESS = `<script>
window.addEventListener("DOMContentLoaded", function () {
  ${NO_INTRO ? "window.__pinned.run();" : ""}
  ${PAGE ? `try { go(${JSON.stringify(PAGE)}); } catch (e) {}` : ""}
  ${AT && !NO_INTRO ? "setTimeout(function () { window.__pinned.run(); }, 30);" : ""}
});
</script>`;

function inject(html) {
  const head = html.match(/<head[^>]*>/i);
  if (!head) return html + HARNESS;
  const at = head.index + head[0].length;
  const seed = (NO_INTRO ? NO_INTRO_SEED : "") + updateSeed();
  return html.slice(0, at) + `<script src="/__dev/mock.js"></script>` + seed + PINNED_CLOCK + html.slice(at);
}

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); }
  catch { res.writeHead(400); return res.end("Bad request path"); }
  if (p.indexOf("\0") !== -1) { res.writeHead(400); return res.end("Bad request path"); }

  if (p === "/__dev/mock.js") {
    let body;
    try { body = fs.readFileSync(MOCK); }
    catch (e) { res.writeHead(500); return res.end("mock missing: " + e.message); }
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(body);
  }
  if (p === "/") p = "/index.html";

  // Contain the served path inside src/. A dev server that can read the whole
  // disk eventually serves the signing key.
  const target = path.join(SRC, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!target.startsWith(SRC)) { res.writeHead(403); return res.end("Forbidden"); }

  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("404 " + p); }
    const ext = path.extname(target).toLowerCase();
    if (ext === ".html") {
      let html = inject(buf.toString("utf8"));
      html = html.replace("</body>", HARNESS + "</body>");
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-store" });
      return res.end(html);
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const url = "http://127.0.0.1:" + port + "/";
  const tmp = path.join(process.env.TEMP, "stryv-shot-" + Date.now() + ".png");

  let stderr = "";
  let finished = false;

  const bail = (msg) => {
    if (finished) return;
    finished = true;
    console.error("  FAILED: " + msg);
    try { child.kill(); } catch (e) {}
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
    server.close();
    process.exit(1);
  };

  // Asynchronous on purpose - see the header note.
  const child = spawn(browser, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--disable-features=Translate,BackForwardCache",
    "--force-device-scale-factor=1",
    "--window-size=" + W + "," + H,
    "--virtual-time-budget=" + BUDGET,
    "--timeout=25000",
    "--screenshot=" + tmp,
    url,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  child.stderr.on("data", (b) => { stderr += b.toString(); });
  child.on("error", (e) => bail("browser failed to start: " + e.message));
  child.on("exit", (code) => {
    if (finished) return;
    if (!fs.existsSync(tmp)) return bail("no screenshot produced (exit " + code + ")\n" + stderr.slice(0, 400));
    const size = fs.statSync(tmp).size;
    if (size < MIN_BYTES) return bail("screenshot is only " + size + " B - that is a blank page, not a render");
    fs.copyFileSync(tmp, OUT);
    fs.unlinkSync(tmp);
    finished = true;
    server.close();
    console.log("  " + OUT + "  " + Math.round(size / 1024) + " KB");
    process.exit(0);
  });
});
