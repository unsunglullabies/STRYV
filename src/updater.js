"use strict";
// STRYV updates. Tauri verifies every artifact against the public key in
// tauri.conf.json before it is allowed to install, so a tampered download is
// rejected rather than run. This file only asks, downloads and starts the
// installer; it never decides what is trustworthy.
const Updater = (() => {
  let pending = null, busy = false;

  const api = () => {
    const core = window.__TAURI__?.core;
    return core && typeof core.invoke === "function" ? core : null;
  };
  const say = (t) => { if (q("updStatus")) q("updStatus").textContent = t; };
  const snoozeKey = () => "upd.snoozed." + VERSION;

  // There is no bundler here, so the Tauri 2 plugin commands are invoked
  // directly rather than imported from npm.
  async function pluginCall(cmd, args) {
    const core = api();
    if (!core) throw new Error("The STRYV backend is not connected.");
    return core.invoke(cmd, args);
  }

  function showInstall(on) {
    const b = q("updInstall");
    if (b) { b.style.display = on ? "" : "none"; }
  }

  async function check(manual) {
    if (busy) return null;
    busy = true;
    const btn = q("updCheck");
    if (btn) btn.disabled = true;
    try {
      say("Checking for updates…");
      const meta = await pluginCall("plugin:updater|check", {});
      if (!meta) {
        showInstall(false);
        if (q("updFound")) q("updFound").style.display = "none";
        say("STRYV " + VERSION + " is up to date.");
        if (manual) toast("No update available");
        return null;
      }
      pending = meta;
      if (q("updFound")) q("updFound").style.display = "";
      if (q("updFoundV")) q("updFoundV").textContent = "STRYV " + meta.version + " is available.";
      if (q("updNotes")) q("updNotes").textContent = meta.body || "";
      showInstall(true);
      if (manual) {
        toast("STRYV " + meta.version + " is available");
      } else if (store.get(snoozeKey(), "") !== meta.version) {
        toast("STRYV " + meta.version + " is available. Open Settings to install it.");
        Act.log({ text: "Update available: " + meta.version });
      }
      return meta;
    } catch (e) {
      showInstall(false);
      say("Could not check for updates: " + (e && e.message ? e.message : e));
      if (manual) Tech.add("updater.check", e);
      return null;
    } finally {
      busy = false;
      if (btn) btn.disabled = false;
    }
  }

  async function install() {
    if (!pending || busy) return;
    busy = true;
    const btn = q("updInstall");
    const core = api();
    if (btn) { btn.disabled = true; btn.textContent = "Installing…"; }
    try {
      say("Downloading update…");
      let onEvent;
      if (core && typeof core.Channel === "function") {
        let done = 0;
        const ch = new core.Channel();
        ch.onmessage = (e) => {
          if (e && e.event === "Progress" && e.data && e.data.contentLength) {
            done += e.data.chunkLength || 0;
            const pct = Math.min(99, Math.round((done / e.data.contentLength) * 100));
            say("Downloading update… " + pct + "%");
          }
        };
        onEvent = ch;
      }
      const args = onEvent ? { onEvent, rid: pending.rid } : { rid: pending.rid };
      await pluginCall("plugin:updater|download_and_install", args);
      say("Installing. STRYV will close and reopen.");
      Act.log({ text: "Update installed: " + pending.version });
      store.set(snoozeKey(), pending.version);
      // On Windows the installer quits the app itself; restart is only a fallback.
      try { await pluginCall("plugin:process|restart", {}); } catch { /* installer already took over */ }
    } catch (e) {
      say("Could not install the update: " + (e && e.message ? e.message : e));
      Tech.add("updater.install", e);
      toast("Update failed to install", true);
      Act.log({ text: "Update install failed", status: "failed", detail: String(e) });
    } finally {
      busy = false;
      if (btn) { btn.disabled = false; btn.textContent = "Install update"; }
    }
  }

  const checkBtn = q("updCheck");
  if (checkBtn) checkBtn.onclick = () => check(true);
  const installBtn = q("updInstall");
  if (installBtn) installBtn.onclick = () => install();
  showInstall(false);
  if (q("updFound")) q("updFound").style.display = "none";
  say("Not checked yet.");

  return { check, install, isAvailable: () => !!api() };
})();
