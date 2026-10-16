/* STRYV — site behaviour.
   Two things only, and both are progressive enhancements: the small-screen nav
   disclosure, and marking which in-page section the reader is looking at.
   With JavaScript off, every link is still visible and every link still works. */
"use strict";

(function () {
  /* ---------------------------------------------------------------------
     Small-screen navigation.

     Below 900px the sidebar becomes a top bar. Without JS the five links sit
     there as a scrollable strip (pure CSS, .nav has no display:none). With JS
     the strip is replaced by a disclosure button, which is why main.html sets
     .js on <html> before first paint.
     ------------------------------------------------------------------- */
  var toggle = document.querySelector("[data-navtoggle]");
  var nav = document.getElementById("nav");

  if (toggle && nav) {
    var closeNav = function () {
      nav.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    };

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });

    // A link was followed: close the menu before the reader moves on.
    nav.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("a")) closeNav();
    });

    document.addEventListener("click", function (e) {
      if (!nav.classList.contains("open")) return;
      if (nav.contains(e.target) || toggle.contains(e.target)) return;
      closeNav();
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !nav.classList.contains("open")) return;
      closeNav();
      toggle.focus();
    });
  }

  /* ---------------------------------------------------------------------
     Scroll spy, for the in-page links on index.html.

     Same amber rule as the current page in the app's sidebar: whichever
     section occupies the top of the viewport is the one you are reading.
     ------------------------------------------------------------------- */
  var links = Array.prototype.slice.call(document.querySelectorAll(".nav a[data-spy]"));
  if (!links.length || !("IntersectionObserver" in window)) return;

  var targets = links
    .map(function (a) { return document.querySelector(a.getAttribute("href")); })
    .filter(Boolean);

  if (!targets.length) return;

  var ratios = {};

  var mark = function (id) {
    links.forEach(function (a) {
      if (id && a.getAttribute("href") === "#" + id) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  };

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      ratios[e.target.id] = e.isIntersecting ? e.intersectionRatio : 0;
    });

    var best = null;
    var top = 0;
    targets.forEach(function (t) {
      var r = ratios[t.id] || 0;
      if (r > top) { top = r; best = t.id; }
    });

    // Nothing in the band yet (top of the page, or between two sections):
    // fall back to the first section so the rail is never fully unmarked.
    mark(best || targets[0].id);
  }, { rootMargin: "-72px 0px -55% 0px", threshold: [0, 0.1, 0.35, 0.6, 1] });

  targets.forEach(function (t) { observer.observe(t); });

  // Update on click too, so the rail responds before the scroll settles.
  links.forEach(function (a) {
    a.addEventListener("click", function () {
      mark(a.getAttribute("href").slice(1));
    });
  });
})();