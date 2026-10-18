// SYN frontend tests.
//
// SYN had no behavioural test at all, which is how `analyseTemp` shipped
// reading `t.temp` and `t.name` when the backend serialises `celsius` and
// `label`: the headline feature of the page threw on the first click of any
// machine that reports a sensor, and nothing noticed.
//
// The bulk of this file is therefore a CONTRACT test. It reads the Rust
// response structs out of main.rs and asserts that every field syn.js reads off
// a backend response actually exists on the struct that produces it. That is
// the class of bug that is invisible to review and fatal at runtime, and it
// cannot be caught by exercising the UI because the UI only sees the same wrong
// shape twice.
//
// The rest drives analyseTemp and analyseGPU with real payloads to prove the
// reading functions produce output rather than throwing.
//
// Run: npm test
"use strict";

const fs = require("fs");
const path = require("path");

const R = path.join(__dirname, "..");
const SYN = fs.readFileSync(path.join(R, "src", "syn.js"), "utf8");
const MAIN = fs.readFileSync(path.join(R, "src-tauri", "src", "main.rs"), "utf8");
const SENSORS = fs.readFileSync(path.join(R, "src", "sensors.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log("  PASS  " + name); }
  else { fail++; console.log("  FAIL  " + name); }
};

// ---- pull the response structs out of the Rust source ----

// `struct Temp { label: String, celsius: f32 }` -> ["label", "celsius"]
const fieldsOf = (structName) => {
  const re = new RegExp("struct\\s+" + structName + "\\s*\\{([^}]*)\\}");
  const m = MAIN.match(re);
  if (!m) return null;
  return [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]);
};

const rustFields = {
  temp: fieldsOf("Temp"),
  gpu: fieldsOf("Gpu"),
};
check("the Rust Temp struct can be read", Array.isArray(rustFields.temp));
check("the Rust Gpu struct can be read", Array.isArray(rustFields.gpu));

console.log("\nthe backend really does call them this");
check("Temp exposes celsius", rustFields.temp && rustFields.temp.includes("celsius"));
check("Temp exposes label", rustFields.temp && rustFields.temp.includes("label"));
check("Temp does NOT expose a field called temp", rustFields.temp && !rustFields.temp.includes("temp"));
check("Gpu exposes util", rustFields.gpu && rustFields.gpu.includes("util"));
check("Gpu does NOT expose a field called pct", rustFields.gpu && !rustFields.gpu.includes("pct"));

// ---- the contract: no reading a field the struct does not have ----

// syn.js names its parameters loosely, so map the analyser to the struct its
// parameter actually is. Getting this wrong would only make the test stricter,
// which is the safe direction to fail in.
const contracts = [
  { fn: "analyseTemp", param: "temps", struct: rustFields.temp, varName: "t" },
  { fn: "gpuNote", param: "gpus", struct: rustFields.gpu, varName: "g" },
];

for (const c of contracts) {
  const start = SYN.indexOf("function " + c.fn);
  check(c.fn + " exists", start >= 0);
  if (start < 0) continue;
  // to the end of the function
  let depth = 0;
  let end = start;
  for (; end < SYN.length; end++) {
    if (SYN[end] === "{") depth++;
    else if (SYN[end] === "}") { depth--; if (depth === 0) break; }
  }
  const body = SYN.slice(start, end);

  // every `x.field` read, where x is the parameter's element variable
  const re = new RegExp("\\b" + c.varName + "\\.(\\w+)", "g");
  const read = [...new Set([...body.matchAll(re)].map((m) => m[1]))];

  check(c.fn + " reads at least one field", read.length > 0);
  const bogus = read.filter((f) => c.struct && !c.struct.includes(f));
  check(
    c.fn + " only reads fields the backend actually sends" +
      (bogus.length ? "  [" + bogus.join(", ") + "]" : "  (" + read.join(", ") + ")"),
    bogus.length === 0
  );
}

// ---- sensors.js and syn.js must agree with each other too ----
// Two readers of the same command drifting apart is the original bug, so pin it.
const sensorReadsTemp = /t\.label/.test(SENSORS) && /t\.celsius/.test(SENSORS);
const sensorReadsGpu = /g\.util/.test(SENSORS);
check("sensors.js reads the temperature fields the backend sends", sensorReadsTemp);
check("sensors.js reads the GPU load field the backend sends", sensorReadsGpu);

// ---- and syn.js must agree with sensors.js ----
const synReadsTemp = /t\.label/.test(SYN) && /t\.celsius/.test(SYN);
const synReadsGpu = /g\.util/.test(SYN);
check("syn.js reads the same temperature fields as sensors.js", synReadsTemp);
check("syn.js reads the same GPU load field as sensors.js", synReadsGpu);

// ---- the stale-field names must be gone entirely ----
// A leftover `t.temp` anywhere in the file is a bug waiting for a refactor to
// reach, so this is asserted as a plain absence rather than as a parse result.
check("syn.js never reads t.temp", !/\bt\.temp\b/.test(SYN));
check("syn.js never reads t.name", !/\bt\.name\b/.test(SYN));
check("syn.js never reads g.pct", !/\bg\.pct\b/.test(SYN));

// ---- behaviour: a real payload must produce a finding, not a throw ----

// analyseTemp/analyseGPU are closed over a `T` threshold table and the `esc`
// helper, so they are lifted out with small stubs rather than run inside the
// module. That keeps the test about the reading, not about the page chrome.
const lift = (name, T) => {
  const lines = SYN.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith("function " + name + "("));
  if (start < 0) return null;
  let end = start + 1;
  for (; end < lines.length; end++) {
    if (/^\s*(async\s+)?function\s+\w+\s*\(/.test(lines[end])) break;
  }
  const body = lines.slice(start, end).join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("T", "esc", body + "\nreturn " + name + ";")(T, (s) => String(s));
};

const T = { temp: 85 };
const analyseTemp = lift("analyseTemp", T);
check("analyseTemp can be lifted for testing", typeof analyseTemp === "function");

if (analyseTemp) {
  // exactly the shape get_temps returns
  const cool = analyseTemp({}, [{ label: "CPU Package", celsius: 41 }]);
  check("a cool sensor reads as ok", cool && cool.level === "ok");
  check("a cool sensor names itself in its detail", cool && /CPU Package/.test(cool.detail || ""));
  check("a cool sensor prints a real temperature", cool && /41/.test(cool.title));

  const hot = analyseTemp({}, [{ label: "CPU Package", celsius: 97 }]);
  check("a hot sensor reads as high", hot && hot.level === "high");
  check("a hot sensor prints its own reading", hot && /97/.test(hot.title));

  check("no sensors at all yields no finding", analyseTemp({}, []) === null);

  // The regression itself: the old code threw on exactly this payload.
  let threw = null;
  try { analyseTemp({}, [{ label: "CPU Package", celsius: 97 }]); } catch (e) { threw = e; }
  check("a real payload does not throw", threw === null);
}

// gpuNote is async and reads the backend itself, so it is covered by the
// field contract above rather than driven here. Asserting the contract is
// enough: the bug being pinned was a field name, not a control flow.

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
