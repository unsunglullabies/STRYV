// Validates every JSON file in the repo and reports version fields.
// PowerShell 5.1's ConvertFrom-Json cannot parse package-lock.json, because it
// contains an empty-string key ("packages": { "": ... }), so node does this.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const files = [
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/capabilities/default.json",
  "tests/fixtures/atlas-games.json",
];

let bad = 0;
for (const rel of files) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.log("  MISSING  " + rel); bad++; continue; }
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const bits = [];
    if (j.version) bits.push("version=" + j.version);
    if (j.name) bits.push("name=" + j.name);
    if (j.packages && j.packages[""] && j.packages[""].version) bits.push('packages[""]=' + j.packages[""].version);
    if (j.plugins && j.plugins.updater) {
      bits.push("pubkey=" + (j.plugins.updater.pubkey ? j.plugins.updater.pubkey.length + " chars" : "MISSING"));
      bits.push("endpoint=" + ((j.plugins.updater.endpoints || [])[0] || "MISSING"));
    }
    console.log("  ok    " + rel + (bits.length ? "   " + bits.join("  ") : ""));
  } catch (e) {
    console.log("  BAD   " + rel + " :: " + e.message);
    bad++;
  }
}

// The app's own VERSION must agree with the packaged versions, or the updater
// will compare the wrong strings.
const core = fs.readFileSync(path.join(ROOT, "src", "core.js"), "utf8");
const appV = (core.match(/const VERSION = "([^"]+)"/) || [])[1];
const pkgV = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const lockV = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")).version;
const confV = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).version;
const cargoV = (fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m) || [])[1];
// Sliced and evaluated rather than regex-matched. The regex expected
// "CHANGELOG = [{" on one line, but the array opens on its own line - so it never
// matched, the newest version read as undefined, and this whole check has been
// exiting 1 while never being run. scripts/release-notes.js already solves this
// the same way; it is the approach both should use.
const changelogV = (() => {
  const marker = "const CHANGELOG = [";
  const start = core.indexOf(marker);
  if (start < 0) return undefined;
  const from = start + marker.length - 1;
  const to = core.indexOf("];", from);
  if (to < 0) return undefined;
  const entries = vm.runInNewContext("(" + core.slice(from, to + 1) + ")");
  return entries[0] && entries[0].v;
})();

console.log("");
console.log("  core.js VERSION   : " + appV);
console.log("  CHANGELOG[0].v    : " + changelogV);
console.log("  package.json      : " + pkgV);
console.log("  package-lock      : " + lockV);
console.log("  tauri.conf.json   : " + confV);
console.log("  Cargo.toml        : " + cargoV);

const all = [appV, pkgV, lockV, confV, cargoV];
if (new Set(all).size !== 1) { console.log("\n  *** VERSIONS DISAGREE ***"); bad++; }
if (changelogV !== appV) { console.log("\n  *** CHANGELOG newest entry does not match VERSION ***"); bad++; }
if (!bad) console.log("\n  every version agrees, and the changelog leads with it");

process.exit(bad ? 1 : 0);