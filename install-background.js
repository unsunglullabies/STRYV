"use strict";
// Applies the small edits that Tasks + background mode need. Safe to run more than once:
// it only adds what is missing, and keeps a one-time backup of every file it changes.
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const P = {
  main: path.join(root, "src-tauri", "src", "main.rs"),
  cargo: path.join(root, "src-tauri", "Cargo.toml"),
  html: path.join(root, "src", "index.html"),
  bg: path.join(root, "src-tauri", "src", "bg.rs"),
};
let problems = 0;
const say = (m) => console.log("  " + m);
const bad = (m) => { problems++; console.log("  !! " + m); };

function load(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  return { raw, eol: raw.includes("\r\n") ? "\r\n" : "\n", text: raw.replace(/\r\n/g, "\n") };
}
function save(file, doc) {
  const bak = file + ".before-background";
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, doc.raw);
  fs.writeFileSync(file, doc.text.replace(/\n/g, doc.eol));
}

console.log("\nSTRYV: installing Tasks + background mode into " + root + "\n");

if (!fs.existsSync(P.bg)) {
  bad("src-tauri\\src\\bg.rs is missing. Unzip the package into your project folder first (the folder that contains src and src-tauri).");
  process.exit(1);
}

// ---------------------------------------------------------------- main.rs
(function mainRs() {
  const d = load(P.main);
  if (!d) return bad("Could not find src-tauri\\src\\main.rs. Run this from your project folder.");
  let t = d.text, did = 0;
  const step = (name, has, apply, manual) => {
    if (has) return say("main.rs: " + name + " already there");
    const out = apply();
    if (out === null) return bad("main.rs: could not find the place to add " + name + ". Add this by hand: " + manual);
    t = out; did++; say("main.rs: added " + name);
  };

  step("`mod bg;`", /^\s*mod\s+bg\s*;/m.test(t),
    () => /^fn main\s*\(\s*\)/m.test(t) ? t.replace(/^fn main\s*\(\s*\)/m, "mod bg; // background monitor, tray, notifications, task manager\n\nfn main()") : null,
    "put `mod bg;` on its own line above `fn main() {`");

  step("the notification plugin", /tauri_plugin_notification::init\(\)/.test(t),
    () => /\.plugin\(tauri_plugin_dialog::init\(\)\)/.test(t) ? t.replace(/(\n[ \t]*)\.plugin\(tauri_plugin_dialog::init\(\)\)/, "$1.plugin(tauri_plugin_dialog::init())$1.plugin(tauri_plugin_notification::init())") : null,
    "add `.plugin(tauri_plugin_notification::init())` next to the other `.plugin(...)` lines");

  step("the close-to-tray hook", /bg::on_window_event/.test(t),
    () => /\.plugin\(tauri_plugin_notification::init\(\)\)/.test(t) ? t.replace(/(\n[ \t]*)\.plugin\(tauri_plugin_notification::init\(\)\)/, "$1.plugin(tauri_plugin_notification::init())$1.on_window_event(bg::on_window_event)") : null,
    "add `.on_window_event(bg::on_window_event)` after the plugin lines");

  step("`bg::init(app)?;`", /bg::init\(\s*app\s*\)\s*\?/.test(t),
    () => /\.setup\(\s*(?:move\s*)?\|\s*(\w+)\s*\|\s*\{/.test(t) ? t.replace(/(\.setup\(\s*(?:move\s*)?\|\s*(\w+)\s*\|\s*\{)/, (m, all, v) => all + "\n            bg::init(" + v + ")?;") : null,
    "add `bg::init(app)?;` as the first line inside `.setup(|app| { ... })`");

  step("the 8 new commands", /bg::task_list/.test(t),
    () => /tauri::generate_handler!\s*\[/.test(t) ? t.replace(/(tauri::generate_handler!\s*\[)/, "$1bg::task_list, bg::task_end, bg::task_end_many, bg::alerts_get, bg::alerts_set, bg::alerts_recent, bg::alerts_clear, bg::alerts_test, ") : null,
    "add `bg::task_list, bg::task_end, bg::task_end_many, bg::alerts_get, bg::alerts_set, bg::alerts_recent, bg::alerts_clear, bg::alerts_test,` at the start of `tauri::generate_handler![`");

  if (did) { d.text = t; save(P.main, d); }
})();

// ---------------------------------------------------------------- Cargo.toml
(function cargoToml() {
  const d = load(P.cargo);
  if (!d) return bad("Could not find src-tauri\\Cargo.toml.");
  let t = d.text, did = 0;

  const line = t.match(/^tauri\s*=\s*(.*)$/m);
  if (!line) bad("Cargo.toml: no `tauri = ...` line found. Set it to: tauri = { version = \"2\", features = [\"tray-icon\"] }");
  else if (/tray-icon/.test(line[1])) say("Cargo.toml: tray-icon already enabled");
  else {
    let v = line[1], out;
    if (/^"[^"]*"\s*$/.test(v)) out = "{ version = " + v.trim() + ", features = [\"tray-icon\"] }";
    else if (/features\s*=\s*\[\s*\]/.test(v)) out = v.replace(/features\s*=\s*\[\s*\]/, "features = [\"tray-icon\"]");
    else if (/features\s*=\s*\[/.test(v)) out = v.replace(/features\s*=\s*\[/, "features = [\"tray-icon\", ");
    else out = v.replace(/\s*\}\s*$/, ", features = [\"tray-icon\"] }");
    t = t.replace(/^tauri\s*=\s*.*$/m, "tauri = " + out); did++; say("Cargo.toml: enabled the tray icon");
  }

  if (/tauri-plugin-notification/.test(t)) say("Cargo.toml: notification plugin already listed");
  else if (/^tauri-plugin-dialog\s*=.*$/m.test(t)) { t = t.replace(/^(tauri-plugin-dialog\s*=.*)$/m, "$1\ntauri-plugin-notification = \"2\""); did++; say("Cargo.toml: added the notification plugin"); }
  else if (/^\[dependencies\]/m.test(t)) { t = t.replace(/^(\[dependencies\][^\n]*)$/m, "$1\ntauri-plugin-notification = \"2\""); did++; say("Cargo.toml: added the notification plugin"); }
  else bad("Cargo.toml: add this line under [dependencies]: tauri-plugin-notification = \"2\"");

  if (did) { d.text = t; save(P.cargo, d); }
})();

// ---------------------------------------------------------------- index.html
(function indexHtml() {
  const d = load(P.html);
  if (!d) return bad("Could not find src\\index.html.");
  let t = d.text;
  const tags = ["tasks.js", "bgui.js"].filter((f) => !t.includes('src="' + f + '"'));
  if (!tags.length) return say("index.html: scripts already added");
  const add = tags.map((f) => '<script src="' + f + '"></script>').join("");
  const anchors = ['<script src="dashx.js"></script>', '<script src="glassfx.js"></script>', '<script src="core.js"></script>'];
  const a = anchors.find((x) => t.includes(x));
  if (a) t = t.replace(a, a + add);
  else if (/<\/body>/i.test(t)) t = t.replace(/<\/body>/i, add + "\n</body>");
  else return bad("index.html: add this before </body>: " + add);
  d.text = t; save(P.html, d); say("index.html: added " + tags.join(" and "));
})();

console.log(problems
  ? "\nFinished with " + problems + " problem(s) above. Everything else was applied.\n"
  : "\nAll done. Now rebuild STRYV the way you normally do (for example: npm run build).\nOriginals were saved next to each file as *.before-background.\n");
process.exit(problems ? 1 : 0);
