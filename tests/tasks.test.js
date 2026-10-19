"use strict";
// Mounts src/tasks.js in a minimal fake DOM and checks that it actually registers
// itself.
//
// boot.test.js already proves every page script parses, which is not the same
// thing: a module can parse perfectly and still throw on its first line, or
// quietly never add its page. The Tasks page arrived as a hand-off zip that was
// merged without ever being run by a test, so this is the first time any of it
// executes outside a browser.
//
// It also proves the shape the module documents: its own page, its own sidebar
// button, its own palette entries, and no edits to shared files.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "tasks.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src", "index.html"), "utf8");

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

const made = [];
const calls = [];

function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    value: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    appendChild(c) { this.children.push(c); return c; },
    after(c) { inserted.push(c); },
    append(...c) { this.children.push(...c); },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener(ev, fn) { (this._l = this._l || {})[ev] = fn; },
    onclick: null,
    oninput: null,
    onchange: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() {},
  };
  made.push(el);
  return el;
}

const mainEl = makeEl("main");
const byId = {};
const inserted = [];
const navButton = makeEl("button");

const PAGES = ["dashboard", "system"];
const COMMANDS = [];

const sandbox = {
  console,
  PAGES,
  COMMANDS,
  go: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
  window: {
    __TAURI__: {
      core: {
        invoke(cmd, args) {
          calls.push({ cmd, args });
          if (cmd === "task_list") return Promise.resolve([]);
          if (cmd === "alerts_get") return Promise.resolve({ enabled: false, rules: [] });
          return Promise.resolve(null);
        },
      },
    },
  },
  document: {
    readyState: "complete",
    // Once a node is appended, ids inside it become findable - that is what
    // mount() relies on when it reaches into the page it just inserted. Returning
    // null here made the module throw on a line that is correct in a browser.
    getElementById: (id) => {
      if (byId[id]) return byId[id];
      const host = mainEl.children.concat(made).map((e) => e.innerHTML || "").join("");
      if (!host.includes('id="' + id + '"')) return null;
      byId[id] = makeEl("div");
      byId[id].id = id;
      return byId[id];
    },
    createElement: (tag) => makeEl(tag),
    addEventListener: (ev, fn) => { if (ev === "DOMContentLoaded") fn(); },
    querySelector: (sel) => {
      if (sel === "main") return mainEl;
      if (sel && sel.indexOf("#nav") === 0) return navButton;
      return null;
    },
    querySelectorAll: () => [],
    hidden: false,
  },
};

vm.createContext(sandbox);

let threw = null;
try {
  vm.runInContext(SRC, sandbox, { filename: "tasks.js" });
} catch (e) {
  threw = e;
}

check("tasks.js runs without throwing", !threw, threw && (threw.stack || String(threw)));

if (!threw) {
  check("it adds itself as a page", PAGES.includes("tasks"), "PAGES is now " + JSON.stringify(PAGES));
  check("it registers a palette command", COMMANDS.some((c) => Array.isArray(c) && c[0] === "Go to Tasks"),
    "COMMANDS is now " + JSON.stringify(COMMANDS.map((c) => c[0])));

  // The section is appended to main, which is what actually makes the page exist.
  const section = mainEl.children.find((c) => c && c.id === "tasks");
  check("it creates its own page element", !!section, "main received " + mainEl.children.length + " child(ren)");

  if (section) {
    const markup = section.innerHTML || "";
    check("the page has a table to list processes in", /tkB/.test(markup));
    check("it ships a search box", /tkQ/.test(markup));
    check("it states it will not end Windows itself", /will not end Windows/i.test(markup),
      "that sentence is a promise to the user and belongs in the markup");
  }

  const btn = inserted.find((b) => b && b.dataset && b.dataset.p === "tasks");
  check("it inserts its own sidebar button", !!btn);
  check("the button is labelled Tasks", !!btn && /Tasks/.test(btn.innerHTML || ""));
  check("the button navigates to the page", !!btn && typeof btn.onclick === "function");
}

// The module is documented as self-contained. Prove it did not need shared files
// edited to work, which is the claim that actually matters here.
check("index.html needs no tasks markup",
  !/id="tasks"/.test(HTML) && !/data-p="tasks"/.test(HTML),
  "a page that has to be added to index.html by hand is not self-contained");

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);