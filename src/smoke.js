// ============================================================================
// STRYV smoke field - a procedural volumetric renderer
// ============================================================================
// WHY THE FIRST ATTEMPT AT THIS LOOKED WRONG (twice, in different ways)
//
// Original: pre-baked sprites drawn as scaled billboards. Each sprite was one
// radial falloff, 128px, drawn up to 560px. Magnifying a smooth blob IS a
// blurred stretched texture, and six blobs repeated 340 times read as
// wallpaper. Base colour was [38,40,48]-[186,190,206], a blue-shifted gray,
// applied uniformly, so the whole cloud was purple-gray.
//
// Rewrite #1: a density field, but with two flaws that produced exactly the
// complaint again. (a) At 0.22 scale the field was upscaled 4.5x, which is
// silk, not smoke. (b) The rim/violet term keyed off low density, which is most
// of the frame, so the entire screen washed purple. Both are fixed below.
//
// WHAT THIS DOES
// A per-pixel density field, sampled the way fluid actually is:
//
//   1. Two envelopes - a plume column at the nozzle and a spreading ground
//      cloud - confine density to where smoke can physically be.
//   2. Domain-warped fbm supplies billow structure. Warping sample coordinates
//      by another noise lookup folds the field so lobes overlap and interlock
//      instead of sitting as discrete blobs.
//   3. A steep density curve. Smoke has holes in it. A field that is uniformly
//      mid-density is fog, and fog is what we are trying not to ship.
//   4. Lighting from the field's own gradient, so every billow is lit by its
//      actual shape: near-black in the body, brighter where the surface turns
//      toward the flame, a tight violet rim only on genuine edges.
// ============================================================================

// A genuinely dark, neutral body. The launch screen background is #0A0A0C, so
// anything brighter than this reads as haze rather than smoke.
const SMOKE_DARK = [26, 25, 30];
const SMOKE_LIT = [138, 133, 142];
const SMOKE_RIM = [138, 112, 186];   // restrained violet, edges only
const SMOKE_HEAT = [122, 92, 66];    // warm, only near the flame
const FLAME_RGB = [255, 212, 146];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// --- value noise -------------------------------------------------------------
// Integer hash -> value noise with a quintic fade. Quintic rather than cubic
// because the second derivative stays continuous, so octave boundaries do not
// leave grid creases that read as banding in the upscale.
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
  const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function fbm(x, y, oct, gain) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= 2.07; // off 2.0, otherwise octaves align to the axes
  }
  return sum / norm;
}

class SmokeField {
  /**
   * @param scale field resolution relative to the viewport. Higher is sharper
   *   and more expensive. Default 0.32: 0.22 upscaled 4.5x and read
   *   as smeared silk (the original complaint); 0.4 costs ~30ms at 1100x600.
   */
  constructor(scale = 0.32) {
    this.scale = scale;
    this.fw = 0; this.fh = 0;
    this.dens = null;
    this.rgba = null;
    this.img = null;
    this.dirty = true;
    this.buf = document.createElement("canvas");
    this.bctx = this.buf.getContext("2d", { willReadFrequently: false });
  }

  resize(cssW, cssH, spread) {
    // Resolution drops as the cloud expands: full-screen smoke is large and soft,
    // so the extra cells buy nothing visible, while the same cells are worth a
    // lot while the plume is still a narrow column.
    const sc = spread == null ? this.scale
      : this.scale * (spread > 0.55 ? 1 - 0.42 * ((spread - 0.55) / 0.45) : 1);
    const fw = Math.max(2, Math.round(cssW * sc));
    const fh = Math.max(2, Math.round(cssH * sc));
    if (fw === this.fw && fh === this.fh) return false;
    this.fw = fw; this.fh = fh;
    this.dens = new Float32Array(fw * fh);
    // Low-frequency copy of the density. Lighting normals must be taken from the
    // smooth form of the field: reading them off the full field made grad
    // dominated by high-frequency speckle, which lit the smoke as torn streaks.
    this.lumb = new Float32Array(fw * fh);
    this.rgba = new Float32Array(fw * fh * 3);
    this.img = new ImageData(fw, fh);
    this.buf.width = fw; this.buf.height = fh;
    return true;
  }

  /**
   * @param {number} T   ms since ignition
   * @param {object} g   geometry (vw, vh, cx, cy, nozY, bh, rh)
   * @param {object} p   phases { plume, ground, spread, fill }
   */
  render(T, g, p) {
    const { fw, fh, dens, lumb, rgba, img } = this;
    const data = img.data;
    const drift = T * 0.00007;
    const swirl = T * 0.00013;
    const spread = p.spread;

    // Normalised plume space. ny is height above the nozzle; nx is horizontal
    // offset. Both divided by viewport height so the plume keeps its proportions
    // at any window size.
    const gndR = 0.11 + spread * 1.5;

    for (let y = 0; y < fh; y++) {
      const py = y / fh;
      const ny = (g.vh - py * g.vh - g.nozY) / g.vh;
      for (let x = 0; x < fw; x++) {
        const px = x / fw;
        const nx = (px * g.vw - g.cx) / g.vh;
        const i = y * fw + x;

        // --- plume column ---------------------------------------------------
        // Widens with distance below the nozzle. Ignition produces a narrow,
        // concentrated column; that is the difference between exhaust and mist.
        const colW2 = 0.030 + Math.min(0.30, Math.abs(ny) * 0.62);
        const below = clamp01((-ny) / 0.05);          // fade in just under the bell
        const column = clamp01(1 - Math.abs(nx) / colW2) * below * p.plume;

        // --- ground cloud ---------------------------------------------------
        // A wide low cloud centred on the pad, which then rolls outward.
        const gr = gndR;
        const gd = Math.hypot(nx / gr, (ny + 0.055) / (gr * 0.52));
        const ground = clamp01(1 - gd) * p.ground;

        let env = column * 0.92 + ground;
        if (env <= 0.004) { dens[i] = 0; continue; }
        env = clamp01(env);

        // --- domain warp ----------------------------------------------------
        // Sampling fbm at coordinates displaced by another fbm is what turns
        // discrete blobs into folded, interlocking billows.
        const wx = nx * 3.1 + swirl + Math.sin(ny * 2.6 + T * 0.0005) * 0.22;
        const wy = ny * 3.1 - drift * 7;
        const wa = fbm(wx * 0.9 + 11.3, wy * 0.9 + 4.1, 2, 0.5);
        const wb = fbm(wx * 0.9 - 7.7, wy * 0.9 + 19.2, 2, 0.5);
        const bx = wx + (wa - 0.5) * 2.1;
        const by = wy + (wb - 0.5) * 2.1;

        // --- structure --------------------------------------------------------
        // Low-frequency form. This is the mass of the smoke and the only thing
        // the lighting reads, so it stays smooth by construction.
        const body = fbm(bx * 1.25, by * 1.25, 3, 0.5);
        // A single high-frequency octave at low weight, modulating alpha only.
        // Ridged noise was removed entirely: its high contrast is what terraced
        // the field into contour bands, and no amount of weighting fixed it.
        const detail = fbm(bx * 5.5 - drift * 26, by * 7.0 + swirl * 11, 1, 0.5);

        let s = clamp01((body - 0.30) * 2.35);
        s = s * s * (3 - 2 * s);
        // Capped below 1 so the field never plateaus. A saturated region has
        // zero gradient, which reads as a flat cut-out rather than volume.
        const d = Math.min(0.94, env * s * 1.05) * (0.88 + detail * 0.24);

        dens[i] = d;
        lumb[i] = env * s;
      }
    }

    // --- lighting from the field's own gradient ------------------------------
    const lx = -0.62, ly = 0.78; // light comes from the flame, below and behind
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = y * fw + x;
        const d = dens[i];
        const o = i * 3;
        if (d < 0.006) {
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
          data[i * 4 + 3] = 0;
          continue;
        }
        // Stride 2 smooths the normal further; stride 1 on an already noisy
        // field is what produced the fibrous, torn-streak lighting.
        const s2 = 2;
        const xm = x > 0 ? i - s2 : i, xp = x < fw - 1 ? i + s2 : i;
        const ym = y > 0 ? i - s2 * fw : i, yp = y < fh - 1 ? i + s2 * fw : i;
        const gx = lumb[xp] - lumb[xm];
        const gy = lumb[yp] - lumb[ym];
        const grad = Math.hypot(gx, gy);
        const len = grad || 1;
        // Monotone, no hard gates: a sharp transfer curve banded the shading.
        const lam = clamp01(((-gx / len) * lx + (-gy / len) * ly) * 0.62 + 0.5);
        // Normalised edge strength, remapped so it stays continuous at 0.
        const edge = clamp01(grad * 5.0);

        // Heat falls off from the nozzle.
        const py = y / fh;
        const nx = (x / fw * g.vw - g.cx) / g.vh;
        const ny = (g.vh - py * g.vh - g.nozY) / g.vh;
        const heat = clamp01(1 - Math.hypot(nx, ny) / (0.09 + spread * 0.42)) * p.plume;

        let r = lerp(SMOKE_DARK[0], SMOKE_LIT[0], lam);
        let gg = lerp(SMOKE_DARK[1], SMOKE_LIT[1], lam);
        let b = lerp(SMOKE_DARK[2], SMOKE_LIT[2], lam);

        // Violet rim, tightly gated: needs a strong gradient AND mid density.
        // Keying this off low density instead is what washed the whole frame.
        const rim = edge * (1 - heat) * 0.34 * clamp01(1.25 - d);
        r = lerp(r, SMOKE_RIM[0], rim);
        gg = lerp(gg, SMOKE_RIM[1], rim);
        b = lerp(b, SMOKE_RIM[2], rim);

        const hot = heat * heat * 0.9;
        r = lerp(r, SMOKE_HEAT[0], hot);
        gg = lerp(gg, SMOKE_HEAT[1], hot);
        b = lerp(b, SMOKE_HEAT[2], hot);

        rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b;

        // Alpha carries density, steeply. Dense cores read solid; the fringes
        // fall off fast, which is what gives smoke a defined edge.
        const a = clamp01(Math.pow(d, 0.85) * 1.05) * 255;
        data[i * 4] = r; data[i * 4 + 1] = gg; data[i * 4 + 2] = b;
        data[i * 4 + 3] = a > 255 ? 255 : a;
      }
    }

    this.bctx.putImageData(img, 0, 0);
    return this.buf;
  }

  /** Blit the finished field, upscaled with bilinear filtering. */
  blit(ctx, g, alpha, cvW, cvH) {
    if (alpha <= 0.002) return;
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalAlpha = alpha;
    const dw = cvW || g.vw, dh = cvH || g.vh;
    ctx.drawImage(this.buf, 0, 0, this.fw, this.fh, 0, 0, dw, dh);
    ctx.restore();
  }

  /** Flame core, additive, drawn over the smoke rather than into it. */
  core(ctx, g, cx, cy, radius, intensity) {
    if (intensity <= 0.004 || radius <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gr.addColorStop(0, `rgba(${FLAME_RGB[0]},${FLAME_RGB[1]},${FLAME_RGB[2]},${intensity})`);
    gr.addColorStop(0.4, `rgba(246,166,35,${intensity * 0.4})`);
    gr.addColorStop(1, "rgba(245,166,35,0)");
    ctx.fillStyle = gr;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  dispose() {
    this.dens = null;
    this.lumb = null;
    this.rgba = null;
    this.img = null;
    // Zeroing the dimensions releases the backing store immediately instead of
    // waiting for GC: the launch screen allocates on every run.
    this.buf.width = this.buf.height = 0;
    this.buf = null;
    this.bctx = null;
  }
}

if (typeof window !== "undefined") window.SmokeField = SmokeField;
if (typeof module !== "undefined" && module.exports) module.exports = SmokeField;
