// Rust source checks that are reliable WITHOUT a Rust toolchain.
//
// Deliberately no delimiter-balance check: a hand-rolled string/comment
// stripper produced false positives on main.rs, which GitHub Actions compiles
// cleanly. A checker that cries wolf gets ignored, and ignoring it is worse
// than not having one. Real validation is `cargo check`, which only runs in CI.
//
// What this does check, reliably, by matching raw source text:
//   1. every #[tauri::command] is registered in generate_handler!
//   2. nothing is registered that does not exist
//   3. ATLAS's public surface is present
//   4. Game/Session/AtlasStore derive what serialization needs
const fs = require("fs");

// main.rs plus any sibling modules. Aery lives in its own file, and its commands
// have to be checked just as strictly as ATLAS's.
const src = [process.argv[2], ...process.argv.slice(3)]
  .filter(Boolean)
  .map((f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } })
  .join("\n");
let failures = 0;
const fail = (m) => { console.log("  FAIL  " + m); failures++; };
const pass = (m) => console.log("  ok    " + m);

// The attribute may carry arguments: `#[tauri::command(async)]` runs a
// synchronous command on its own thread instead of the async runtime, which is
// what the sysinfo-backed commands want. Both spellings are valid, so accept
// both rather than forcing a revert of a correct change.
const defs = [...src.matchAll(/#\[tauri::command(?:\([^)]*\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)].map((m) => m[1]);
const handlerMatch = src.match(/generate_handler!\[([^\]]+)\]/);
const reg = handlerMatch ? handlerMatch[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
// A command in a module is registered as module::name but defined as fn name,
// so both sides are compared as the bare name.
const bare = (n) => n.replace(/^[A-Za-z_][A-Za-z0-9_]*::/, "");
const regBare = reg.map(bare);
console.log(`  ${defs.length} commands defined, ${reg.length} registered`);

const unregistered = defs.filter((d) => !regBare.includes(d));
const ghost = regBare.filter((r) => !defs.includes(r));

if (unregistered.length) fail(`defined but not registered: ${unregistered.join(", ")}`);
if (ghost.length) fail(`registered but not defined: ${ghost.join(", ")}`);
if (!unregistered.length && !ghost.length) pass("every command is reachable from the handler");

const need = [
  "fn atlas_scan",
  "fn atlas_launch_id",
  "fn atlas_launch",
  "fn atlas_add_manual",
  "fn atlas_remove",
  "fn atlas_restore",
  "fn atlas_set_favorite",
  "fn atlas_sessions",
  "fn atlas_clear_sessions",
  "fn aery_list",
  "fn aery_read",
  "fn aery_save",
  "fn aery_create",
  "fn aery_rename",
  "fn aery_delete",
  "fn aery_restore",
  "fn aery_set_pinned",
  "fn aery_set_folder",
  "fn aery_vaults",
  "fn aery_vault_open",
  "fn aery_vault_create",
  "fn aery_vault_forget",
  "fn merge_library",
  "fn canonicalize",
  "fn scan",
  "fn registry",
  "fn push_session",
  "fn steam_start",
  "fn atlas_source_list",
  "fn atlas_set_source",
  "fn atlas_source_list",
  "fn atlas_set_source",
  "fn read_atlas",
  "fn write_atlas",
];
const missing = need.filter((n) => !src.includes(n));
if (missing.length) fail(`missing ATLAS functions: ${missing.join(", ")}`);
else pass(`all ${need.length} ATLAS functions present`);

// The derive list may carry extra traits, so check for the two we actually need
// rather than matching an exact attribute string.
for (const ty of ["Game", "Session", "AtlasStore"]) {
  const i = src.indexOf(`struct ${ty} {`);
  if (i < 0) { fail(`struct ${ty} not found`); continue; }
  const before = src.slice(Math.max(0, i - 900), i);
  const attr = (before.match(/#\[derive\(([^\]]*)\)\][^#]*$/) || [])[1] || "";
  const has = (t) => attr.split(",").some((x) => x.trim() === t);
  if (has("Serialize") && has("Deserialize")) pass(`${ty} derives Serialize + Deserialize  [${attr.trim()}]`);
  else fail(`${ty} needs Serialize and Deserialize, found: [${attr.trim() || "no derive"}]`);
}

// The old 0.2.0 frontend field names must survive: an older UI still calls them.
for (const f of ["launcher", "app_id", "name", "install_dir", "size_bytes", "last_played"]) {
  const g = src.slice(src.indexOf("struct Game {"), src.indexOf("struct Game {") + 700);
  if (!g.includes(`${f}:`)) fail(`Game lost the '${f}' field the 0.2.0 frontend reads`);
}
if (!failures) pass("Game keeps every field the 0.2.0 frontend reads");

console.log(failures === 0 ? "\n  STRUCTURE OK (not a substitute for cargo check)" : `\n  ${failures} PROBLEM(S)`);
process.exit(failures === 0 ? 0 : 1);
