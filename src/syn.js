"use strict";
// ============================================================================
// SYN — system intelligence for STRYV
// ============================================================================
// WHAT THIS IS NOT
// It is not a chatbot and it does not pretend to be one. No model is connected.
// Every finding below is derived arithmetically from a reading STRYV actually
// took from this machine, and every one of them cites the number it came from.
//
// WHY THAT IS STILL WORTH BUILDING
// The hard part of "why is my CPU at 90%" is not the phrasing, it is knowing
// that mock-game.exe is holding 62% of it. That comparison is deterministic,
// instant, offline, and cannot hallucinate. SYN does that part properly and
// labels the rest as unavailable rather than faking it.
//
// A provider can be connected later, behind the same interface, with explicit
// per-feature consent. Nothing leaves this machine until someone opts in to
// something specific.
// ============================================================================
const SYN = (() => {
  const q = (id) => document.getElementById(id);

  // ---- thresholds ---------------------------------------------------------
  // These are stated thresholds, not diagnoses. SYN says what it observed and
  // what the observation usually means, never what is wrong with your PC.
  const T = { cpu: 70, mem: 80, disk: 90, temp: 85, net: 0 };

  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
  const gb = (b) => (b / 1073741824).toFixed(1) + " GB";
  const mb = (b) => (b / 1048576).toFixed(0) + " MB";

  let invoke = null;
  try { invoke = window.__TAURI__?.core?.invoke; } catch (e) { /* not under Tauri */ }

  // ---- the rule engine ----------------------------------------------------
  // Each rule returns null or a finding. A finding always carries the evidence
  // it was derived from, so the user can check it rather than trust it.

  function analyseCPU(snap, procs) {
    const cpu = snap?.cpu_usage;
    if (typeof cpu !== "number") return null;
    if (cpu < T.cpu) {
      return {
        level: "ok", title: "CPU is not under pressure",
        detail: `${cpu.toFixed(0)}% in use right now.`,
        why: "Below 70% there is usually headroom for everything else running.",
      };
    }
    // Rank the process list rather than naming a single culprit.
    const top = (procs || []).slice().sort((a, b) => b.cpu - a.cpu).slice(0, 3);
    const evidence = top.filter((p) => p.cpu > 1);
    return {
      level: cpu >= 90 ? "high" : "warn",
      title: `CPU is at ${cpu.toFixed(0)}%`,
      detail: evidence.length
        ? `The heaviest processes are ${evidence.map((p) => `${p.name} at ${p.cpu.toFixed(0)}%`).join(", ")}.`
        : "No single process stands out, so the load is spread across many.",
      why: "Per-process figures are share of total CPU, so they sum to roughly 100% across busy processes. A busy process is not automatically the problem — a task manager running an index rebuild often looks worse than it is.",
    };
  }

  function analyseMemory(snap, procs) {
    const used = snap?.mem_used, total = snap?.mem_total;
    if (typeof used !== "number" || !total) return null;
    const p = pct(used, total);
    if (p < T.mem) {
      return {
        level: "ok", title: "Memory has room",
        detail: `${gb(used)} of ${gb(total)} in use (${p.toFixed(0)}%).`,
        why: "Windows also keeps cached memory that it will release on demand, so this figure falling short of 100% is not a problem in itself.",
      };
    }
    const top = (procs || []).slice().sort((a, b) => b.mem - a.mem).slice(0, 3);
    return {
      level: p >= 92 ? "high" : "warn",
      title: `Memory is at ${p.toFixed(0)}%`,
      detail: top.length
        ? `Largest by memory: ${top.map((x) => `${x.name} at ${mb(x.mem)}`).join(", ")}.`
        : "No process list is available, so the biggest consumer cannot be named.",
      why: "If the working set rises steadily over minutes, something is leaking. If it rises and falls, it is normal use.",
    };
  }

  function analyseDisk(snap) {
    const disks = snap?.disks || [];
    const withRoom = disks
      .map((d) => ({ ...d, freePct: pct(d.available, d.total) }))
      .sort((a, b) => a.freePct - b.freePct);
    const worst = withRoom[0];
    if (!worst || worst.total === 0) return null;
    if (worst.freePct > T.disk) {
      return {
        level: "ok", title: "Disk space looks fine",
        detail: disks.map((d) => `${d.name} has ${gb(d.available)} free`).join("; ") + ".",
        why: "",
      };
    }
    return {
      level: worst.freePct >= 97 ? "high" : "warn",
      title: `${worst.name} is ${worst.freePct.toFixed(0)}% full`,
      detail: `${gb(worst.available)} free of ${gb(worst.total)}.`,
      why: "Windows needs room for pagefile growth and updates. Filling a system drive is one of the more reliable ways to cause slowness that nothing else explains.",
    };
  }

  function analyseTemp(snap, temps) {
    const t = temps?.length ? temps.reduce((a, b) => (b.celsius > a.celsius ? b : a)) : null;
    if (!t) return null;
    if (t.celsius < T.temp) {
      return {
        level: "ok", title: `Highest sensor reads ${t.celsius.toFixed(0)}°C`,
        detail: `${t.label}.`,
        why: "",
      };
    }
    return {
      level: t.celsius >= 95 ? "high" : "warn",
      title: `${t.label} is at ${t.celsius.toFixed(0)}°C`,
      detail: "Sustained readings above 85°C usually mean the cooling is not keeping up with the load.",
      why: "Short spikes under load are normal. It is the reading that stays high while the machine is idle that matters.",
    };
  }

  function analyseUptime(snap) {
    const s = snap?.uptime_secs;
    if (!s) return null;
    const d = Math.floor(s / 86400);
    return {
      level: "ok",
      title: d > 0 ? `Up for ${d} day${d === 1 ? "" : "s"}` : "Up for less than a day",
      detail: "This session started " + new Date(Date.now() - s * 1000).toLocaleString() + ".",
      why: "",
    };
  }

  async function gather() {
    if (!invoke) return { error: "The STRYV backend is not available in this window." };
    try {
      const [snap, procs, temps] = await Promise.all([
        invoke("get_snapshot").catch(() => null),
        invoke("get_processes").catch(() => null),
        invoke("get_temps").catch(() => null),
      ]);
      if (!snap) return { error: "Live system data could not be read from this PC." };
      return { snap, procs, temps };
    } catch (e) {
      return { error: "Could not read this PC: " + (e && e.message ? e.message : String(e)) };
    }
  }

  async function runDiagnostics() {
    const box = q("synOut");
    if (!box) return;
    box.innerHTML = '<p class="note">Reading this PC...</p>';
    const g = await gather();
    if (g.error) {
      box.innerHTML = '<p class="note" style="color:var(--bad)">' + esc(g.error) + "</p>";
      return;
    }
    const findings = [
      analyseCPU(g.snap, g.procs),
      analyseMemory(g.snap, g.procs),
      analyseDisk(g.snap),
      analyseTemp(g.snap, g.temps),
      analyseUptime(g.snap),
    ].filter(Boolean);

    if (!findings.length) {
      box.innerHTML = '<p class="note">This PC did not report enough to analyse.</p>';
      return;
    }
    const worst = findings.some((f) => f.level === "high") ? "high"
      : findings.some((f) => f.level === "warn") ? "warn" : "ok";
    const stamp = new Date().toLocaleTimeString();
    box.innerHTML =
      '<p class="note">Measured ' + esc(stamp) + " from a live reading. Every figure below came from this PC.</p>" +
      findings.map((f) => SYN.card(f)).join("");
    box.setAttribute("data-level", worst);
  }

  function card(f) {
    return (
      '<div class="synfind ' + f.level + '">' +
      '<b>' + esc(f.title) + "</b>" +
      '<span>' + esc(f.detail) + "</span>" +
      (f.why ? '<small>' + esc(f.why) + "</small>" : "") +
      "</div>"
    );
  }

  // ---- questions ----------------------------------------------------------
  // Rule-based, over a live reading. If nothing matches it says so. It never
  // guesses, and it never implies a model answered.

  const ANSWERS = [
    { re: /\bwhy\b.*\b(cpu|processor)\b|\bcpu\b.*\b(high|busy|slow|pegged)\b/i, run: async (g) => analyseCPU(g.snap, g.procs) },
    { re: /\b(cpu|processor)\b|\bhow much\b.*\bcpu\b/i, run: async (g) => analyseCPU(g.snap, g.procs) },
    { re: /\b(ram|memory)\b/i, run: async (g) => analyseMemory(g.snap, g.procs) },
    { re: /\b(disk|drive|storage|space)\b/i, run: async (g) => analyseDisk(g.snap) },
    { re: /\b(temp|temperature|hot|overheat|thermal)\b/i, run: async (g) => analyseTemp(g.snap, g.temps) },
    { re: /\buptime\b|\bhow long\b.*\b(up|been running)\b/i, run: async (g) => analyseUptime(g.snap) },
    { re: /\bwho\b.*\busing\b|\btop process\b|\bwhat.*\busing\b/i, run: async (g) => SYN.topProc(g.procs) },
    { re: /\b(gpu|graphics|video card)\b/i, run: async (g) => SYN.gpuNote() },
  ];

  async function topProc(procs) {
    if (!procs || !procs.length) return null;
    const top = procs.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 5);
    return {
      level: "ok",
      title: "Heaviest processes by CPU",
      detail: top.map((p) => `${p.name} ${p.cpu.toFixed(0)}% cpu, ${mb(p.mem)}`).join(" · "),
      why: "Share of total CPU, taken from a single live sample.",
    };
  }

  async function gpuNote() {
    try {
      const g = await invoke("get_gpu");
      if (!g) return null;
      return {
        level: "ok", title: "GPU",
        detail: `${g.name || "Unknown GPU"}${typeof g.util === "number" ? " at " + g.util.toFixed(0) + "% load" : ""}.`,
        why: "GPU load is a share of the card, not of system CPU.",
      };
    } catch (e) {
      return {
        level: "warn", title: "GPU readings are unavailable",
        detail: "This PC did not report GPU load through the backend.",
        why: "",
      };
    }
  }

  async function ask(question) {
    const out = q("synAsk");
    if (!out) return;
    const text = (question || "").trim();
    if (!text) return;
    out.innerHTML = '<p class="note">Reading this PC...</p>';
    const g = await gather();
    if (g.error) { out.innerHTML = '<p class="note" style="color:var(--bad)">' + esc(g.error) + "</p>"; return; }

    for (const a of ANSWERS) {
      if (!a.re.test(text)) continue;
      const f = await a.run(g);
      if (f) {
        out.innerHTML = SYN.card(f) +
          '<p class="note">Answered from a live reading of this PC. No model was involved.</p>';
        return;
      }
    }
    // The honest failure: say what it can do instead of inventing an answer.
    out.innerHTML =
      '<div class="synfind warn"><b>SYN cannot answer that yet</b>' +
      "<span>It can explain CPU, memory, disk, temperatures, uptime and process load, because those come from a live reading of this PC.</span>" +
      "<small>Anything needing interpretation rather than measurement needs a model, and none is connected.</small></div>";
  }

  // ---- wiring -------------------------------------------------------------

  function renderAeryScope() {
    const host = q("synAeryScope");
    if (!host || typeof Aery === "undefined") return;
    const notes = (Aery.notes && Aery.notes()) || [];
    host.innerHTML = notes.length
      ? notes.map((n) =>
          '<label class="set"><div><b>' + esc(n.title || n.path) + "</b><small>" + esc(n.path) + "</small></div>" +
          '<input type="checkbox" data-synnote="' + esc(n.path) + '"></label>').join("")
      : '<p class="note">No notes yet. Nothing can be shared, and nothing would be.</p>';
  }

  function wire() {
    const run = q("synRun");
    if (run) run.onclick = runDiagnostics;
    const askBtn = q("synAskGo");
    if (askBtn) askBtn.onclick = () => ask(q("synAskQ").value);
    const askIn = q("synAskQ");
    if (askIn) askIn.addEventListener("keydown", (e) => { if (e.key === "Enter") ask(askIn.value); });
    renderAeryScope();
    // Deliberately NOT auto-run. It costs three backend reads on every visit and
    // leaves a "Reading this PC..." placeholder sitting in an empty panel until the
    // user asks for a check. The button is right there.
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }

  return { runDiagnostics, ask, notes: renderAeryScope, answers: ANSWERS.map((a) => a.re.source) };
})();
