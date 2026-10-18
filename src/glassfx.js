"use strict";
// Native window glass (Windows 10/11): the desktop shows through the window.
// The page only turns translucent AFTER Windows confirms the effect, so a failure can never
// leave the app see-through but unblurred.
const GlassFX = (() => {
  const KEY = "stryv.glassfx";
  const FX = { mica: { effects: ["mica"] }, acrylic: { effects: ["acrylic"], color: [10, 10, 16, 205] } };
  const root = document.documentElement;
  let mode = "off";
  const win = () => { try { return window.__TAURI__.window.getCurrentWindow(); } catch (e) { return null; } };
  async function set(next, save) {
    const w = win();
    if (!w || typeof w.setEffects !== "function") { root.classList.remove("fx"); return false; }
    try {
      if (next === "off") { await w.clearEffects(); root.classList.remove("fx"); }
      else { await w.setEffects(FX[next]); root.classList.add("fx"); }
      mode = next;
      if (save) { try { localStorage.setItem(KEY, next); } catch (e) { /* not fatal */ } }
      return true;
    } catch (e) {
      root.classList.remove("fx");
      try { await w.clearEffects(); } catch (e2) { /* nothing to clear */ }
      if (typeof Tech !== "undefined") Tech.add("window glass (" + next + ")", String(e));
      return false;
    }
  }
  const saved = () => { try { const v = localStorage.getItem(KEY); return v === "off" || v === "mica" || v === "acrylic" ? v : null; } catch (e) { return null; } };
  const sel = document.getElementById("gfx");
  async function init() {
    const want = saved() || "off";
    const ok = want === "off" ? true : await set(want, false);
    mode = ok ? want : "off";
    if (sel) sel.value = mode;
  }
  if (sel) sel.onchange = async () => {
    const want = sel.value, ok = await set(want, true);
    if (!ok) { sel.value = "off"; try { localStorage.setItem(KEY, "off"); } catch (e) { /* not fatal */ } if (typeof toast === "function") toast("Window glass isn't available on this PC", true); }
    else if (typeof toast === "function") toast(want === "off" ? "Window glass off" : "Window glass: " + (want === "mica" ? "Mica" : "Acrylic"));
  };
  init();
  return { set, get mode() { return mode; } };
})();
