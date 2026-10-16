"use strict";
// Builds latest.json, the static manifest the Tauri updater fetches from the
// GitHub Release. Run after `npm run build`, with TAURI_SIGNING_PRIVATE_KEY set
// so that Tauri produced the .sig files.
//
// This refuses to write a manifest unless every artifact it lists has a
// matching signature. An unsigned entry would let the updater install something
// the app cannot verify, so it is treated as a hard error rather than a warning.
//
//   node scripts/make-latest-json.js [tag]
//
// Tag defaults to v<version>. The download URL is derived from GITHUB_REPOSITORY
// when running in Actions.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = process.argv[2] || "v" + version;

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error("GITHUB_REPOSITORY is not set; pass the owner/repo, e.g. GITHUB_REPOSITORY=you/name");
  process.exit(2);
}

const bundle = path.join(ROOT, "src-tauri", "target", "release", "bundle");
const targets = [
  { dir: path.join(bundle, "nsis"), arch: "windows-x86_64" },
  { dir: path.join(bundle, "msi"), arch: "windows-x86_64" },
];

const platforms = {};
const problems = [];

for (const { dir, arch } of targets) {
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter((f) => /\.(exe|msi)$/i.test(f));
  for (const file of files) {
    const sigPath = path.join(dir, file + ".sig");
    if (!fs.existsSync(sigPath)) {
      problems.push(`${file} has no .sig - it would be listed without a signature`);
      continue;
    }
    const signature = fs.readFileSync(sigPath, "utf8").trim();
    if (!signature) {
      problems.push(`${file}.sig is empty`);
      continue;
    }
    const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}`;
    platforms[arch] = { signature, url };
  }
}

if (problems.length) {
  console.error("Refusing to write latest.json:");
  for (const p of problems) console.error("  - " + p);
  console.error("\nEvery listed artifact must be signed by TAURI_SIGNING_PRIVATE_KEY before release.");
  process.exit(1);
}

if (!Object.keys(platforms).length) {
  console.error(`No signed installers found under ${bundle}. Build first.`);
  process.exit(1);
}

const notes = process.env.RELEASE_NOTES || "";
const out = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

const outPath = path.join(bundle, "latest.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

console.log("wrote " + path.relative(ROOT, outPath));
console.log("  version : " + version);
console.log("  tag     : " + tag);
console.log("  repo    : " + repo);
for (const [k, v] of Object.entries(platforms)) {
  console.log(`  ${k} -> ${v.url}`);
  console.log(`      signature ${v.signature.length} chars`);
}
