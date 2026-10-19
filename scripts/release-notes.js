"use strict";
// Prints the changelog entry for a version, ready to become a GitHub Release body
// and the notes in the updater manifest.
//
// The source of truth is the CHANGELOG in src/core.js - the same text the app
// shows on its own What's New page. Generating from it means the release cannot
// say one thing while the app says another.
//
//   node scripts/release-notes.js [version] [--short]
//
// Version defaults to the version in tauri.conf.json.
//
// --short produces a summary for the in-app update panel, and is what goes into
// latest.json. The full text is the GitHub Release body.
//
// The two are different formats on purpose. The release body is read on GitHub,
// where Markdown renders. The panel is read inside a settings row, where a wall
// of prose is nobody's idea of a summary - and where the full 4,800-character
// changelog read as one unbroken block of text with the Markdown syntax showing
// through it. A release page wants everything; a "what's new" line wants a count.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SHORT = process.argv.includes("--short");

function currentVersion() {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  return conf.version;
}

function changelog() {
  const src = fs.readFileSync(path.join(ROOT, "src", "core.js"), "utf8");
  const marker = "const CHANGELOG = [";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("CHANGELOG not found in src/core.js");
  // slice starts one back so the "[" of the array literal is included, which is
  // what makes the expression parseable on its own.
  const from = start + marker.length - 1;
  const to = src.indexOf("];", from);
  if (to < 0) throw new Error("CHANGELOG is not terminated");
  return vm.runInNewContext("(" + src.slice(from, to + 1) + ")");
}

const want = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : currentVersion();
const entries = changelog();
const entry = entries.find((e) => e.v === want);

if (!entry) {
  console.error(`No changelog entry for ${want}. Known versions: ${entries.map((e) => e.v).join(", ")}`);
  process.exit(1);
}

const out = [];

if (SHORT) {
  out.push(`## ${entry.v} — ${entry.tag}`);
  out.push("");
  for (const [group, items] of Object.entries(entry.groups)) {
    out.push(`- **${group}** ${items.length}`);
  }
  out.push("");
  out.push("Full release notes:");
  out.push(`https://github.com/unsunglullabies/STRYV/releases/tag/v${entry.v}`);
} else {
  out.push(`## ${entry.v} — ${entry.tag}`);
  out.push("");
  for (const [group, items] of Object.entries(entry.groups)) {
    out.push(`**${group}**`);
    out.push("");
    for (const item of items) out.push(`- ${item}`);
    out.push("");
  }
  out.push("---");
  out.push("");
  out.push(
    "Every STRYV release is signed. The app checks the published feed, downloads the installer, and " +
      "verifies its signature against the key built into the app before running it."
  );
}

process.stdout.write(out.join("\n") + "\n");