"use strict";
// Tests the release-notes renderer in src/updater.js.
//
// The release body arrives over the network and is rendered with innerHTML, so
// the escaping is the security boundary here. A bug in it would turn the release
// feed into an injection point on every client.
//
// The function is sliced out of the real file and run in a vm rather than being
// reimplemented, so this tests the shipped code and not a copy of it.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "updater.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, why) {
  if (cond) {
    pass++;
    console.log("  PASS  " + name);
  } else {
    fail++;
    console.log("  FAIL  " + name + (why ? "\n          " + why : ""));
  }
}

// Take escHtml, inline and renderNotes as they appear in the file.
const start = SRC.indexOf("const escHtml");
const end = SRC.indexOf("const Updater = (() => {");
if (start < 0 || end < 0) {
  console.log("  FAIL  could not find the renderer in src/updater.js");
  process.exit(1);
}
const slice = SRC.slice(start, end);

const ctx = {};
vm.createContext(ctx);
vm.runInContext(slice + "\nthis.renderNotes = renderNotes;", ctx);
const renderNotes = ctx.renderNotes;

// ---- structure ---------------------------------------------------------------
{
  const md = ["## 0.2.9 — The Name On The Box", "", "- **Fixed** 5", "- **New** 3", "", "Full release notes:"].join("\n");
  const html = renderNotes(md);
  check("a heading becomes an element", /<h5>0\.2\.9/.test(html));
  check("bullets become a list", /<ul>/.test(html) && (html.match(/<li>/g) || []).length === 2);
  check("bold becomes strong", /<strong>Fixed<\/strong>/.test(html));
  check("a plain line becomes a paragraph", /<p>Full release notes:<\/p>/.test(html));
  check("no markdown syntax survives", !/^#{1,6}\s/m.test(html) && !/\*\*[^*]+\*\*/.test(html),
    "the whole point: '##' and '**' must not appear as text");
}

// ---- newlines actually survive -----------------------------------------------
{
  const md = ["first line", "", "second line"].join("\n");
  const html = renderNotes(md);
  check("blank lines separate blocks", /<p>first line<\/p><p>second line<\/p>/.test(html),
    "textContent collapsed these into one run");
}

// ---- the security boundary ---------------------------------------------------
{
  const hostile = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(2)<\/script>',
    '**bold** & <b>raw</b>',
    'a < b and c > d',
  ].join("\n");
  const html = renderNotes(hostile);
  check("script tags are escaped", !/<script/i.test(html), html);
  // "onerror" still appearing as visible text is correct: what matters is that the
  // angle brackets around it are escaped, so the browser reads characters rather
  // than an attribute. Asserting the word is absent would be asserting the wrong
  // thing - a note saying "disable onerror" is not an attack.
  check("attribute text is inert because its tag is escaped",
    /&lt;img src=x onerror=/.test(html) && !/<img/.test(html), html);
  check("no live img tag is produced", !/<img/i.test(html), html);
  check("ampersands and angle brackets are escaped", !/ a < b /.test(html) && !/&(?!amp;|lt;|gt;)/.test(html));
  check("bold still works alongside escaped text", /<strong>bold<\/strong>/.test(html));
}

{
  // The old rule was the empty one: the real Game Bar prefix has no trailing dot.
  const html = renderNotes("- **Fixed** 5");
  check("a group line renders as a list item", /<li><strong>Fixed<\/strong> 5<\/li>/.test(html), html);
}

{
  const html = renderNotes("");
  check("empty notes render to nothing", html === "", JSON.stringify(html));
  check("undefined notes render to nothing", renderNotes(undefined) === "");
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);