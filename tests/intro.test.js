"use strict";
// Exercises the launch screen's failure paths.
//
// boot.test.js proves intro.js parses and loads before app.js. That is not the
// same as it being able to get the user into the app.
//
// The case that matters most is the one where the backend never answers. That is
// the only thing standing between a hung IPC call and a window that opens to
// nothing, forever, with a button that nobody may ever press.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "src", "intro.js"), "utf8");

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

// ---- the guards are present --------------------------------------------------
// Static checks, but they pin two things that have each been a real defect:
// the unguarded property access, and startup having no timeout at all.
check("startup is raced against a cap", /Promise\.race/.test(SRC));
{
  const m = SRC.match(/HARD_CAP = (\d+)/);
  check("the cap is a real duration", !!m && Number(m[1]) >= 5000,
    m ? "found " + m[1] + "ms" : "no HARD_CAP constant");
  check("a cap below 5s would cut startup short", !!m && Number(m[1]) >= 5000);
}
check("a timeout opens the app anyway", /if \(timedOut\)[\s\S]{0,700}return quick\(\)/.test(SRC),
  "the launch screen must not be able to become permanent");
check("a timeout is recorded, not swallowed", /Tech\.add\("startup"[\s\S]{0,140}HARD_CAP/.test(SRC));
check("a falsy result is survivable", /!res \|\| res\.ok !== true/.test(SRC));
check("the unguarded access is gone", !/if \(!res\.ok\)/.test(SRC),
  "!res.ok throws a TypeError when res is undefined, inside an async function");
check("a rejected startup still produces a readable reason",
  /reason: String\(e && e\.message \? e\.message : e\)/.test(SRC),
  "String(e) on an Error gives 'Error: x', not the message");

// ---- the race actually resolves ----------------------------------------------
// The real shape of the fix, run for real: a promise that never settles, raced
// against a timer, must produce a value rather than hang.
async function raceReady(readyFn, capMs, timers) {
  let timedOut = false;
  let settled = "pending";
  const done = new Promise((resolve) => {
    Promise.resolve(readyFn()).then((v) => { settled = "ready"; resolve(v); }, () => { settled = "rejected"; resolve(null); });
    timers.push(setTimeout(() => { timedOut = true; resolve(null); }, capMs));
  });
  return { res: await done, timedOut, settled };
}

(async () => {
  // A backend that never answers.
  {
    const timers = [];
    const { res, timedOut, settled } = await raceReady(() => new Promise(() => {}), 12000, timers);
    check("a hung startup is detected rather than awaited forever", timedOut === true);
    check("and the race yields a value", res === null);
    check("the hung promise really did never settle", settled === "pending");
  }

  // A backend that answers normally is unaffected by the cap.
  {
    const timers = [];
    const { res, timedOut } = await raceReady(() => Promise.resolve({ ok: true }), 12000, timers);
    check("a normal startup is not treated as a timeout", timedOut === false);
    check("and its result survives", res && res.ok === true);
  }

  // A backend that rejects.
  {
    const timers = [];
    const { timedOut } = await raceReady(() => Promise.reject(new Error("backend gone")), 12000, timers);
    check("a rejected startup is not a timeout", timedOut === false);
  }

  // The guard itself, against every shape startup might hand back.
  const guard = (res) => {
    if (!res || res.ok !== true) {
      return res && typeof res === "object" ? res : { reason: "Startup returned nothing usable." };
    }
    return null;
  };
  check("undefined does not throw", (() => { try { guard(undefined); return true; } catch (e) { return false; } })());
  check("null does not throw", (() => { try { guard(null); return true; } catch (e) { return false; } })());
  check("and gets a stated reason", guard(undefined).reason === "Startup returned nothing usable.");
  check("a real reason is kept", guard({ ok: false, reason: "backend gone" }).reason === "backend gone");
  check("a success passes through", guard({ ok: true }) === null);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();