// Boot smoke test.
//
// Every page script has to be loadable on its own. node --check validates one
// file at a time and happily passes a file whose only problem is that its
// neighbours are also loaded - a bare `return` in a <script> tag is a syntax
// error in the browser, and a duplicate top-level const only fails once both
// files are on the same page. Neither shows up in a per-file check.
//
// 0.2.3 shipped a black screen because intro.js lost its IIFE wrapper and the
// page died before anything rendered. This exists so that can never happen twice.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const R = path.join(__dirname, "..");
const SRC = path.join(R, "src");
const HTML = fs.readFileSync(path.join(SRC, "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name + (extra ? "\n          " + extra : "")); }
};

console.log("boot smoke tests\n");

// ---- every script the page loads exists, and parses -----------------------
console.log("scripts the page loads");
const scripts = [...HTML.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
{
  check("the page loads at least eight scripts", scripts.length >= 8, "found " + scripts.length);
  const missing = scripts.filter((s) => !fs.existsSync(path.join(SRC, s)));
  check("every script the page loads exists on disk", missing.length === 0, missing.join(", "));

  for (const s of scripts) {
    const src = fs.readFileSync(path.join(SRC, s), "utf8");
    let ok = true, why = "";
    try { new vm.Script(src, { filename: s }); }
    catch (e) { ok = false; why = e.message; }
    check("  " + s + " parses as a browser script", ok, why);
  }
}

// ---- the trap 0.2.3 fell into --------------------------------------------
console.log("\nnothing may return out of the top level");
{
  // A <script> body is not a function, so a top-level return is illegal. It is
  // only valid inside an IIFE. node --check passes such a file happily because
  // it parses it as a module, but a browser parses it as a Script and refuses.
  // vm.Script uses the same Script goal, so this reproduces the real failure.
  for (const s of scripts) {
    const src = fs.readFileSync(path.join(SRC, s), "utf8");
    let illegal = false, why = "";
    try { new vm.Script(src, { filename: s }); }
    catch (e) { if (/Illegal return statement|outside of (a )?function|return.*only.*function/i.test(e.message)) { illegal = true; why = e.message; } }
    check("  " + s + " has no illegal top-level return", !illegal, why);
  }
}

// ---- no two page scripts claim the same top-level name -------------------
console.log("\nno duplicate top-level declarations");
{
  // Column 0 is not the same as top level: everything inside an IIFE sits at
  // column 0 too. Brace depth is the real measure, and it is what makes this
  // check worth having - a duplicate top-level const only fails once both
  // scripts are on the same page.
  const owners = new Map();
  const collisions = [];
  for (const s of scripts) {
    const src = fs.readFileSync(path.join(SRC, s), "utf8");
    let depth = 0;
    for (const line of src.split(/\r?\n/)) {
      const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m && depth === 0) {
        const n = m[1];
        if (owners.has(n)) collisions.push(n + " (" + owners.get(n) + " and " + s + ")");
        else owners.set(n, s);
      }
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth < 0) depth = 0;
    }
  }
  check("no name is declared at the top level twice", collisions.length === 0, collisions.join(", "));
}

// ---- each page script must hand its own object back ----------------------
console.log("\npage scripts expose what app.js calls");
{
  const expected = {
    "intro.js": "Intro",
    "aery.js": "Aery",
    "atlas.js": "Atlas",
  };
  for (const [file, global] of Object.entries(expected)) {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const assigned = new RegExp("^(?:const|let|var)\\s+" + global + "\\s*=", "m").test(src);
    check("  " + file + " assigns " + global, assigned);
    check("  " + file + " " + global + " is wrapped in an IIFE", /\(\(\)\s*=>\s*\{/.test(src));
  }
  // app.js reaches for Intro directly; Atlas and Aery render themselves on
  // load, so only their presence as globals matters.
  const app = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
  check("  app.js calls Intro", /\bIntro\s*\./.test(app));
  check("  app.js calls Updater", /\bUpdater\s*\./.test(app));
}

// ---- script order: pages before app.js ------------------------------------
console.log("\nload order");
{
  const at = (s) => scripts.indexOf(s);
  check("core.js is first", at("core.js") === 0);
  check("app.js is last", at("app.js") === scripts.length - 1);
  check("intro.js loads before app.js", at("intro.js") < at("app.js"));
  check("aery.js loads before app.js", at("aery.js") < at("app.js"));
  check("atlas.js loads before app.js", at("atlas.js") < at("app.js"));
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);