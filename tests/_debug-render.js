// Debug: run the real atlas.js through the real test shim and dump what it renders.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(ROOT, "tests", "fixtures", "atlas-games.json"), "utf8")
);

const IDS = [
  "atlasHeroStat", "atlasFeature", "atlasQ", "atlasSort", "atlasFavOnly", "atlasMissingOnly",
  "atlasReset", "atlasGrid", "atlasEmpty", "atlasNote", "atlasRestore", "atlasSessClr",
  "atlasSess", "atlasAdd", "atlasAddBox", "atlasAddTitle", "atlasAddNo", "atlasName",
  "atlasExe", "atlasPickExe", "atlasArt", "atlasPickArt", "atlasAddNo2", "atlasAddGo",
  "atlasEditBox", "atlasEditTitle", "atlasEditNo", "atlasEditName", "atlasEditExe",
  "atlasPickExe2", "atlasEditArt", "atlasPickArt2", "atlasClearArt", "atlasEditNo2",
  "atlasEditSave", "atlasDetailWrap", "atlasDetail",
];

function makeEl(dataset) {
  return {
    dataset: dataset || {},
    disabled: false,
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    style: {},
    onclick: null,
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
    replaceChild() {},
  };
}

function htmlEl() {
  const el = makeEl();
  let h = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return h; },
    set(v) { h = v; },
    enumerable: true,
  });
  el.querySelectorAll = (sel) => {
    const m = /^\[data-([a-z-]+)\]$/.exec(sel);
    if (!m) return [];
    const attr = m[1];
    const tags = h.match(/<[^>]*>/g) || [];
    const out = [];
    for (const t of tags) {
      const a = /data-([a-z-]+)="([^"]*)"/.exec(t);
      if (!a || a[1] !== attr) continue;
      out.push(makeEl({ [attr]: a[2] }));
    }
    return out;
  };
  return el;
}

const els = {};
for (const id of IDS) els[id] = (id === "atlasGrid" || id === "atlasEmpty" || id === "atlasFeature" || id === "atlasDetail" || id === "atlasHeroStat") ? htmlEl() : makeEl();

const sandbox = {
  q: (id) => els[id] || null,
  esc: (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
  toast: () => {},
  confirmBox: async () => true,
  store: { _d: {}, get(k, d) { return k in this._d ? this._d[k] : d; }, set(k, v) { this._d[k] = v; } },
  Act: { log: () => 1, update: () => {} },
  Tech: { add: () => {} },
  console,
  document: { readyState: "complete", createElement: () => makeEl() },
};
sandbox.invoke = (cmd) => {
  if (cmd === "atlas_scan") return Promise.resolve(FIXTURE.games);
  if (cmd === "atlas_sessions") return Promise.resolve([]);
  return Promise.resolve(null);
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "src", "atlas.js"), "utf8"), sandbox);
const Atlas = vm.runInContext("Atlas", sandbox);

(async () => {
  await Atlas.scan(false);
  await new Promise((r) => setTimeout(r, 120));

  const grid = els.atlasGrid.innerHTML;
  console.log("grid length      :", grid.length);
  console.log("articles         :", (grid.match(/<article/g) || []).length);
  console.log("data-cover count :", (grid.match(/data-cover="1"/g) || []).length);
  console.log("data-cdn count   :", (grid.match(/data-cdn="1"/g) || []).length);
  console.log("at-covf count    :", (grid.match(/at-covf/g) || []).length);
  console.log("No cover art     :", /No cover art/.test(grid));
  console.log("data-fallback    :", (grid.match(/data-fallback="1"/g) || []).length);
  console.log("");
  console.log("first card (900 chars):");
  console.log(grid.slice(0, 900));
  console.log("");
  console.log("heroStat:", els.atlasHeroStat.innerHTML.slice(0, 200));
  console.log("feature length:", els.atlasFeature.innerHTML.length);
})();