const invoke = window.__TAURI__?.core?.invoke;
const $ = (id) => document.getElementById(id);
const gb = (b) => (b / 1073741824).toFixed(1) + " GB";
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + "d " : "") + h + "h " + m + "m"; };
async function tick() {
  if (!invoke) { $("cpu").textContent = "Unavailable"; return false; }
  try {
    const s = await invoke("get_snapshot");
    $("cpu").textContent = s.cpu_usage.toFixed(0) + "%"; $("cpuB").style.width = s.cpu_usage + "%";
    const p = s.mem_used / s.mem_total * 100;
    $("mem").textContent = p.toFixed(0) + "%"; $("memB").style.width = p + "%";
    $("memD").textContent = gb(s.mem_used) + " of " + gb(s.mem_total);
    if (typeof Health !== "undefined") Health.push(s);
    H.cpu.push(s.cpu_usage); H.mem.push(p); for (const k in H) if (H[k].length > N) H[k].shift();
    draw("cpuC", H.cpu); draw("memC", H.mem);
    $("up").textContent = dur(s.uptime_secs);
    $("disks").innerHTML = s.disks.map((d) => `<div class="disk"><span>${d.name}</span><span>${gb(d.available)} free of ${gb(d.total)}</span></div>`).join("") || "<small>Unavailable</small>";
  return true;
  } catch (e) { $("cpu").textContent = "Unavailable"; console.error(e); return false; }
}
const H = { cpu: [], mem: [] }, N = 60;
function draw(id, arr, max = 100) {
  const el = $(id), step = 300 / (N - 1), off = N - arr.length;
  const pts = arr.map((v, i) => [(off + i) * step, 88 - Math.min(max, v) / max * 86]);
  let g = [25, 50, 75].map((y) => `<line class="grid" x1="0" x2="300" y1="${88 - y * .86}" y2="${88 - y * .86}"/>`).join("");
  if (pts.length > 1) { const l = pts.map((p) => p.join(",")).join(" "); g += `<polygon class="ar" points="${pts[0][0]},88 ${l} ${pts.at(-1)[0]},88"/><polyline class="ln" points="${l}"/>`; }
  el.innerHTML = g;
}
async function procs() {
  if (!invoke) return false;
  try {
    const p = await invoke("get_processes"); window.LastProcs = p;
    $("procT").innerHTML = p.map((x) => `<tr><td style="color:var(--t)">${x.name}</td><td class="n">${x.cpu.toFixed(1)}%</td><td class="n">${(x.mem / 1048576).toFixed(0)} MB</td></tr>`).join(""); return true;
  } catch (e) { $("procT").innerHTML = "<tr><td>Unavailable</td></tr>"; return false; }
}
H.dl = []; H.ul = [];
const mbps = (b) => (b / 1e6).toFixed(b < 1e7 ? 2 : 1) + " Mbps";
async function net() {
  if (!invoke) return false;
  try {
    const all = await invoke("get_network");
    const real = all.filter((x) => x.rx_bps + x.tx_bps > 0 || x.mac !== "00:00:00:00:00:00");
    const d = real.reduce((a, x) => a + x.rx_bps, 0), u = real.reduce((a, x) => a + x.tx_bps, 0);
    $("dl").textContent = mbps(d); $("ul").textContent = mbps(u);
    $("net").textContent = "↓ " + mbps(d); $("netU").textContent = "↑ " + mbps(u);
    H.dl.push(d / 1e6); H.ul.push(u / 1e6); for (const k of ["dl", "ul"]) if (H[k].length > N) H[k].shift();
    const mx = (k) => Math.max(10, ...H[k]);
    draw("dlC", H.dl, mx("dl")); draw("ulC", H.ul, mx("ul"));
    $("adT").innerHTML = real.map((x) => `<tr><td style="color:var(--t)">${x.name}</td><td>${x.mac}</td><td class="n">↓ ${mbps(x.rx_bps)}</td><td class="n">↑ ${mbps(x.tx_bps)}</td></tr>`).join(""); return true;
  } catch (e) { $("dl").textContent = "Unavailable"; return false; }
}
const ms = (v) => v == null ? "—" : v.toFixed(0) + " ms";
$("runT").onclick = async (e) => {
  e.target.disabled = true; e.target.textContent = "Testing…"; const aid = Act.log({ text: "Network connection tests", status: "running" });
  try {
    const r = await invoke("run_network_tests"); Act.update(aid, { status: "done", detail: JSON.stringify(r, null, 1) });
    $("tests").innerHTML = "<table>" + r.latency.map((l) => `<tr><td style="color:var(--t)">${l.target}</td><td>min ${ms(l.min_ms)} · avg ${ms(l.avg_ms)} · max ${ms(l.max_ms)}</td><td class="n">${l.lost}/${l.sent} failed</td></tr>`).join("") +
      r.dns.map((x) => `<tr><td style="color:var(--t)">DNS ${x.host}</td><td>${x.error ? "Failed: " + x.error : "Resolved"}</td><td class="n">${ms(x.ms)}</td></tr>`).join("") + "</table><small>Failed connections count as loss in this test, but a blocked port can also cause them.</small>";
  } catch (err) { Act.update(aid, { status: "failed", detail: String(err) }); Tech.add("network.tests", err); toast("Network tests failed", true); $("tests").innerHTML = "<small>Test could not run: " + err + "</small>"; }
  e.target.disabled = false; e.target.textContent = "Run again";
};
let rows = [];
async function sys() {
  if (!invoke) return false;
  let i; try { i = await invoke("get_system_info"); } catch (e) { return false; }
  rows = [["Operating system", i.os_version || i.os], ["Device name", i.host], ["Processor", i.cpu_brand], ["Physical cores", i.cpu_cores || "Unavailable"], ["Installed memory", gb(i.mem_total)]];
  $("sysT").innerHTML = rows.map((r) => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join(""); return true;
}
$("copy").onclick = async (e) => { await navigator.clipboard.writeText(rows.map((r) => r.join(": ")).join("\n")); e.target.textContent = "Copied"; toast("Diagnostics copied"); Act.log({ text: "Copied system diagnostics" }); setTimeout(() => e.target.textContent = "Copy diagnostics", 1500); };
function startTimers() { clearInterval(window._a); clearInterval(window._b); const t = Cfg.v.interval * 1000; window._a = setInterval(() => { tick(); net(); }, t); window._b = setInterval(procs, t * 2); }
async function startup() {
  const [snap, info] = await Promise.all([tick(), sys(), procs(), net(), document.fonts && document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => null))]);
  return snap && info ? { ok: true } : { ok: false, reason: !invoke ? "The STRYV backend is not available in this window." : "Could not read " + [!snap && "live system data", !info && "system information"].filter(Boolean).join(" or ") + "." };
}
startTimers(); Intro.run(startup, { ready: async () => {
    const r = await startup();
    // The quiet check used to be fired from here and never actually ran: it was
    // invoked while the intro still owned startup, so it could be cut off when
    // the window appeared. It now runs only once startup is genuinely done, and
    // a failure here must never stop the app from opening.
    if (r.ok && typeof Updater !== "undefined") {
      try { Updater.check(false); } catch (e) { Tech.add("updater", e); }
    }
    return r;
  } });
