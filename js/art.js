// Decorative artwork for the "Ouro" look: isometric wireframe cubes and a
// halftone (dot-matrix) sphere. Everything is built with createElementNS — no
// innerHTML — and colored through CSS (`currentColor`), so the palette lives in
// css/style.css only.

const ART_SVG_NS = "http://www.w3.org/2000/svg";

function svgNode(tag, attrs) {
  const el = document.createElementNS(ART_SVG_NS, tag);
  Object.keys(attrs || {}).forEach((key) => el.setAttribute(key, attrs[key]));
  return el;
}

function isoPoint(x, y, z, scale, ox, oy) {
  const cos30 = Math.cos(Math.PI / 6);
  const sin30 = 0.5;
  return [ox + (x - y) * cos30 * scale, oy + (x + y) * sin30 * scale - z * scale];
}

// cubes: [x, y, z, size] in grid units.
function wireframePathData(cubes, scale, ox, oy) {
  const parts = [];
  cubes.forEach(([x, y, z, size]) => {
    const corners = [];
    for (let dx = 0; dx < 2; dx += 1) {
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dz = 0; dz < 2; dz += 1) {
          corners.push({ k: [dx, dy, dz], p: isoPoint(x + dx * size, y + dy * size, z + dz * size, scale, ox, oy) });
        }
      }
    }
    corners.forEach((a) => {
      corners.forEach((b) => {
        const differsInOneAxis = a.k.reduce((sum, v, i) => sum + Math.abs(v - b.k[i]), 0) === 1;
        if (differsInOneAxis && a.k.join("") < b.k.join("")) {
          parts.push(`M${a.p[0].toFixed(1)} ${a.p[1].toFixed(1)}L${b.p[0].toFixed(1)} ${b.p[1].toFixed(1)}`);
        }
      });
    });
  });
  return parts.join("");
}

function buildWireframe(cubes, scale, ox, oy, strokeWidth, opacity) {
  return svgNode("path", {
    d: wireframePathData(cubes, scale, ox, oy),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": String(strokeWidth),
    "stroke-linecap": "round",
    opacity: String(opacity),
  });
}

// A sphere lit from the top-right, drawn as a hex grid of dots whose radius
// follows the brightness.
function buildHalftone(cx, cy, radius, gap, maxDot) {
  const group = svgNode("g", { fill: "currentColor" });
  const n = Math.floor(radius / gap) + 1;
  for (let i = -n; i <= n; i += 1) {
    for (let j = -n; j <= n; j += 1) {
      const x = i * gap + (j % 2 ? gap / 2 : 0);
      const y = j * gap * 0.866;
      const dist = Math.hypot(x, y);
      if (dist > radius) continue;
      const nx = x / radius;
      const ny = y / radius;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const brightness = Math.max(0, Math.min(1, 0.55 * (-nx * 0.55 + ny * 0.6) + 0.33 * nz + 0.08));
      const r = maxDot * brightness;
      if (r < 0.55) continue;
      group.appendChild(svgNode("circle", { cx: (cx + x).toFixed(1), cy: (cy + y).toFixed(1), r: r.toFixed(2) }));
    }
  }
  return group;
}

function wrapArt(width, height, className, children) {
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: "100%",
    "aria-hidden": "true",
    focusable: "false",
    preserveAspectRatio: "xMidYMid meet",
  });
  svg.setAttribute("class", className);
  children.forEach((child) => svg.appendChild(child));
  return svg;
}

function colored(className, node) {
  const wrap = svgNode("g", {});
  wrap.setAttribute("class", className);
  wrap.appendChild(node);
  return wrap;
}

// Login/brand panel: big halftone sphere with a stack of wireframe cubes.
function buildBrandArt() {
  return wrapArt(820, 600, "art-svg", [
    colored("art-halftone", buildHalftone(500, 300, 230, 13, 5.4)),
    colored(
      "art-wire",
      buildWireframe([[0, 0, 0, 1.6], [1.6, 0, 0, 1.6], [0, 1.6, 0, 1.6], [0, 0, 1.6, 1.6], [1.6, 1.6, 0, 1.6], [3.2, 0, 0, 1.6]], 72, 500, 190, 1.3, 0.85)
    ),
  ]);
}

// "Finan." brand mark (2026-10-12, redrawn 2026-10-12 to fix the F's
// alignment): a rounded square with "F" and a small square dot, replacing
// the earlier two-cube wireframe. The F and the dot are the EXACT path data
// from the real brand SVG the user supplied (124x124 viewBox, rx 27) — a
// font-rendered "F" glyph (the first version of this function) could never
// center/proportion reliably across browsers/sizes the way this fixed,
// hand-authored shape does; `scale` maps that 124-unit artwork onto
// whatever `size` is requested. Colored via CSS (.logo-square/.logo-f/
// .logo-dot in css/style.css), not fixed here, so the same markup reads
// correctly both on a plain light surface and inside the navy sidebar/auth
// panel. Geometry is untouched by the 2026-10-15 blue-accent rebrand — the
// new brand SVGs use these exact same F/dot path coordinates, only the
// dot's CSS fill color (and the wordmark's "Capital" suffix, handled in
// js/segmentos.js) changed.
function buildLogoMark(size) {
  const scale = size / 124;
  const svg = svgNode("svg", {
    viewBox: `0 0 ${size} ${size}`,
    width: String(size),
    height: String(size),
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.setAttribute("class", "art-logo-svg");
  svg.appendChild(
    svgNode("rect", { x: "0", y: "0", width: String(size), height: String(size), rx: (27 * scale).toFixed(2), class: "logo-square" })
  );
  const g = svgNode("g", { transform: `scale(${scale.toFixed(6)})` });
  g.appendChild(
    svgNode("path", {
      d: "M35.902 90.56V29.24H49.678V90.56ZM47.998 65.864V54.44H71.686V65.864ZM47.998 40.664V29.24H72.694V40.664Z",
      class: "logo-f",
    })
  );
  g.appendChild(svgNode("rect", { x: "78.086", y: "75.524", width: "14.784", height: "15.036", class: "logo-dot" }));
  svg.appendChild(g);
  return svg;
}

// Per-segment marks (cat/dog, hex nut, lidded cylinder...) and per-segment
// brand names (FinanGold, FinanPet...) were removed 2026-10-12, on request:
// the app now always shows the one real "Finan." identity, everywhere,
// regardless of a company's segment. Puts the Finan. mark in the sidebar
// logo slot — segment-independent on purpose.
function trocarLogoSegmento() {
  const slot = document.getElementById("sidebar-logo");
  if (!slot) return;
  slot.innerHTML = "";
  slot.appendChild(buildLogoMark(26));
}

// Fills every static slot in the page: [data-art="brand|logo|logo-lg"].
// "brand" (the login screen's big centerpiece) is deliberately left empty
// since 2026-10-12 — the "Finan." look replaces the old wireframe-cube-
// plus-halftone-sphere art with the two faint outlined squares drawn in CSS
// (.auth-brand::before/::after), not JS-built SVG; buildBrandArt() is kept,
// unused, in case a future design wants SVG art there again.
function mountStaticArt() {
  document.querySelectorAll("[data-art]").forEach((slot) => {
    if (slot.firstChild) return;
    const kind = slot.dataset.art;
    if (kind === "logo") slot.appendChild(buildLogoMark(26));
    else if (kind === "logo-lg") slot.appendChild(buildLogoMark(30));
  });
}

mountStaticArt();
