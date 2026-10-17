#!/usr/bin/env node
// ============================================================================
// STRYV dev screenshot helper
// ============================================================================
// WHY THIS EXISTS
// Headless Chromium does not reliably exit when a page holds an open
// connection. The dev page keeps a live-reload EventSource open forever, so
// `--virtual-time-budget` never completes and the browser process hangs until
// it is killed.
//
// This serves the SAME src/ files with the mock backend injected, but WITHOUT
// the reload client. Nothing stays connected, virtual time completes, and the
// browser exits on its own.
//
// It is a screenshot tool. It is not a dev server; use scripts/dev-server.js.
//
// USAGE
//   node scripts/dev-shot.js --out shot.png --at 1200 --size 1280x800
//   node scripts/dev-shot.js --out shot.png --page aery
//
//   --at     ms to fast-forward a pinned clock to, for the launch animation
//   --size   WIDTHxHEIGHT
//   --page   which app page to land on (dashboard, performance, atlas, ...)
//   --no-intro  skip the launch animation entirely
// ============================================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const MOCK = path.join(__dirname, "dev", "mock-backend.js");
const BRAVE = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const OUT = flag("--out", "shot.png");
const SIZE = flag("--size", "1280x800");
const [W, H] = SIZE.split("x").map(Number);
const AT = flag("--at", "");
const PAGE = flag("--page", "");
const NO_INTRO = has("--no-intro");
const BUDGET = parseInt(flag("--budget", "6000"), 10);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
};

// A pinned clock, so the launch animation can be inspected at an exact moment
// instead of wherever the machine happened to be.
// --no-intro goes through the real production path: the same `intro: false`
// setting the user can toggle in Settings. Faking it by cancelling an animation
// loop would prove nothing about the code that actually ships.
const NO_INTRO_SEED = `
<script>
try {
  var s = JSON.parse(localStorage.getItem("stryv.settings") || "{}");
  s.intro = false;
  localStorage.setItem("stryv.settings", JSON.stringify(s));
} catch (e) {}
</script>
`;

const PINNED_CLOCK = `
<script>
(function () {
  var vt = 0, queue = [], err = null;
  Object.defineProperty(performance, "now", { value: function () { return vt; } });
  window.requestAnimationFrame = function (cb) { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = function () {};
  window.addEventListener("error", function (e) { err = e.message; });
  window.__pinned = {
    steps: ${AT ? parseInt(AT, 10) : 0},
    ms: 16,
    run: function () {
      for (var i = 0; i < this.steps; i++) {
        vt += this.ms;
        var b = queue.splice(0, queue.length);
        for (var j = 0; j < b.length; j++) { try { b[j](vt); } catch (e) { err = e.message; } }
      }
    },
    err: function () { return err; }
  };
})();
</script>
`;

const HARNESS = `
<script>
window.addEventListener("DOMContentLoaded", function () {
  var P = window.__pinned;
  ${NO_INTRO ? 'P.run();' : ''}
  ${PAGE ? 'try { go(' + JSON.stringify(PAGE) + '); } catch (e) {}' : ''}
  ${AT && !NO_INTRO ? 'setTimeout(function(){ P.run(); }, 30);' : ''}
});
</script>
`;

function inject(html) {
  const head = html.match(/<head[^>]*>/i);
  if (!head) return html + HARNESS;
  const at = head.index + head[0].length;
  const seed = NO_INTRO ? NO_INTRO_SEED : "";
  return html.slice(0, at) + `\n<script src="/__dev/mock.js"></script>` + seed + PINNED_CLOCK + html.slice(at);
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/__dev/mock.js") {
    res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(MOCK));
  }
  if (p === "/") p = "/index.html";
  const target = path.join(SRC, path.normalize(p).replace(/^([/\\])+/, ""));
  if (!target.startsWith(SRC)) { res.writeHead(403); return res.end("no"); }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("404 " + p); }
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

  const r = spawnSync(BRAVE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
    "--disable-features=Translate,BackForwardCache",
    "--force-device-scale-factor=1",
    "--window-size=" + W + "," + H,
    "--virtual-time-budget=" + BUDGET,
    "--timeout=25000",
    "--screenshot=" + tmp,
    url,
  ], { timeout: 60000, stdio: ["ignore", "ignore", "pipe"] });

  server.close();
  if (r.error) { console.error("  browser failed: " + r.error.message); process.exit(1); }
  if (!fs.existsSync(tmp)) { console.error("  no screenshot produced"); if (r.stderr) console.error(String(r.stderr).slice(0, 400)); process.exit(1); }
  fs.copyFileSync(tmp, OUT);
  fs.unlinkSync(tmp);
  console.log("  " + OUT + "  " + Math.round(fs.statSync(OUT).size / 1024) + " KB");
});
