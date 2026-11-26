import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "assets", "brand");

const PKG = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const APP_VERSION = PKG.version;

function loadRoadmapSteps() {
  const text = readFileSync(resolve(root, "docs/roadmap.md"), "utf8");
  const steps = [];
  for (const line of text.split("\n")) {
    const found = line.match(/^## \d+\. (.+) — (done|next|planned)$/);
    if (found !== null) {
      steps.push({ name: found[1].toUpperCase(), state: found[2].toUpperCase() });
    }
  }
  return steps;
}

const WORDMARK_GLYPHS = {
  u: "M4,26 V48 Q4,66 22,66 H34 Q52,66 52,48 V26",
  r: "M10,66 V4 M10,30 Q10,10 30,10 H44",
  b: "M10,66 V4 M10,30 H30 Q54,30 54,48 Q54,66 30,66 H10",
  d: "M46,66 V4 M46,30 H26 Q2,30 2,48 Q2,66 26,66 H46",
  y: "M4,4 L28,40 L52,4 M28,40 V62",
};

function wordmark({ x, y, scale, top, bottom, dx = 6, dy = 7 }) {
  const order = ["u", "r", "b", "u", "d", "d", "y"];
  const advance = 60;
  const placed = order
    .map(
      (letter, i) =>
        `<path d="${WORDMARK_GLYPHS[letter]}" transform="translate(${i * advance},0)" fill="none"/>`,
    )
    .join("");
  return `<g transform="translate(${x},${y}) scale(${scale})" stroke-linecap="round" stroke-linejoin="round" fill="none"><g transform="translate(${dx},${dy})" stroke="${bottom}" stroke-width="16">${placed}</g><g stroke="${top}" stroke-width="16">${placed}</g></g>`;
}

const INK = "#151515";
const PAPER = "#F4F0DF";
const ACID = "#BAF52E";
const ORANGE = "#FF633B";
const SMOKE = "#8A8672";

const DISPLAY = "Impact,'Arial Black','Franklin Gothic Medium',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

function esc(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_CSS = [
  ".rise{transform-box:fill-box;transform-origin:center;animation:rise .5s cubic-bezier(.2,1.4,.4,1) both}",
  "@keyframes rise{from{transform:translateY(16px) scale(.96)}to{transform:none}}",
  ".wob{transform-box:fill-box;transform-origin:center;animation:wob 3.2s ease-in-out infinite alternate}",
  "@keyframes wob{from{transform:rotate(-2deg)}to{transform:rotate(2deg)}}",
  ".eq{transform-box:fill-box;transform-origin:50% 100%;animation:eq 1.6s ease-in-out infinite alternate}",
  "@keyframes eq{from{transform:scaleY(.55)}to{transform:scaleY(1)}}",
  ".flow{animation:flow 1.8s linear infinite}",
  "@keyframes flow{to{stroke-dashoffset:-28}}",
  ".blink{animation:blink 1.2s steps(1) infinite}",
  "@keyframes blink{50%{opacity:0}}",
  "@media (prefers-reduced-motion:reduce){*{animation:none!important}}",
].join("\n");

function doc({ width, height, label, title, css, defs, body }) {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">`,
    `<title>${esc(title)}</title>`,
    `<style>\n${css}\n</style>`,
    defs ? `<defs>\n${defs}\n</defs>` : "",
    body,
    "</svg>",
    "",
  ].join("\n");
}

function halftone(id, color) {
  return `<pattern id="${id}" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><circle cx="4" cy="4" r="2" fill="${color}" fill-opacity=".22"/></pattern>`;
}

function waveBars({ x, y, width, count, maxH, seed, color, gap = 3 }) {
  const rand = mulberry32(seed);
  const slot = width / count;
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const h = 6 + rand() * maxH;
    const bx = x + i * slot;
    const delay = (i % 7) * 0.13;
    bars.push(
      `<rect class="eq" style="animation-delay:${delay.toFixed(2)}s" x="${bx.toFixed(1)}" y="${(y - h).toFixed(1)}" width="${(slot - gap).toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`,
    );
  }
  return `<g>\n${bars.join("\n")}\n</g>`;
}

function burst({ cx, cy, rays, r0, r1, color, width }) {
  const rand = mulberry32(rays * 131 + Math.round(cx));
  const paths = [];
  for (let i = 0; i < rays; i += 1) {
    const a = (i / rays) * Math.PI * 2 + rand() * 0.12;
    const len = r0 + rand() * (r1 - r0);
    const x2 = cx + Math.cos(a) * len;
    const y2 = cy + Math.sin(a) * len;
    paths.push(
      `<line x1="${cx}" y1="${cy}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="${width}"/>`,
    );
  }
  return `<g stroke-linecap="round">\n${paths.join("\n")}\n</g>`;
}

const assets = {};

assets["hero.svg"] = () => {
  const bars = waveBars({
    x: 60,
    y: 392,
    width: 780,
    count: 52,
    maxH: 30,
    seed: 20261126,
    color: ACID,
  });
  const headline = (line, y, fill, delay) =>
    `<g class="rise" style="animation-delay:${delay}s" font-family="${DISPLAY}"><text x="88" y="${y + 5}" font-size="68" fill="${ORANGE}" textLength="500" lengthAdjust="spacingAndGlyphs">${line}</text><text x="84" y="${y}" font-size="68" fill="${fill}" textLength="500" lengthAdjust="spacingAndGlyphs">${line}</text></g>`;
  return doc({
    width: 900,
    height: 424,
    label: "Urbuddy hero. Break the language barrier. Hear, understand, respond, evolve.",
    title: "Urbuddy — break the language barrier",
    css: BASE_CSS,
    defs: halftone("hero-dots", PAPER),
    body: [
      `<rect width="900" height="424" fill="url(#hero-dots)"/>`,
      `<g class="rise" transform="rotate(-3 700 200)"><polygon points="120,120 700,96 688,300 700,308 640,392 108,380" fill="${ORANGE}"/></g>`,
      `<g class="rise" style="animation-delay:.1s" transform="rotate(1.5 400 220)"><polygon points="80,100 668,88 656,296 668,304 608,388 72,376" fill="${INK}"/></g>`,
      `<g class="rise" style="animation-delay:.18s"><polygon points="48,84 640,72 628,280 660,288 600,372 40,360" fill="${PAPER}"/></g>`,
      burst({ cx: 800, cy: 76, rays: 14, r0: 26, r1: 66, color: ORANGE, width: 6 }),
      `<g class="rise" style="animation-delay:.05s">${wordmark({ x: 64, y: 34, scale: 0.38, top: INK, bottom: ORANGE })}</g>`,
      headline("BREAK THE", 168, INK, 0.22),
      headline("LANGUAGE", 240, INK, 0.3),
      headline("BARRIER.", 312, INK, 0.38),
      `<g class="rise" style="animation-delay:.46s" font-family="${MONO}" font-size="16" font-weight="700" fill="${PAPER}">`,
      `<polygon points="60,330 560,324 552,356 52,360" fill="${INK}"/>`,
      `<text x="76" y="351" textLength="470" lengthAdjust="spacingAndGlyphs">HEAR &#183; UNDERSTAND &#183; RESPOND &#183; EVOLVE</text>`,
      `</g>`,
      bars,
    ].join("\n"),
  });
};

assets["transformation.svg"] = () => {
  const noise = waveBars({
    x: 60,
    y: 190,
    width: 300,
    count: 30,
    maxH: 84,
    seed: 77,
    color: SMOKE,
  });
  const clear = waveBars({
    x: 540,
    y: 190,
    width: 300,
    count: 30,
    maxH: 44,
    seed: 78,
    color: ACID,
  });
  return doc({
    width: 900,
    height: 320,
    label:
      "Transformation. Noisy English speech becomes understandable Indonesian context. Illustrative mock, not captured output.",
    title: "Urbuddy transformation — illustrative mock",
    css: BASE_CSS,
    defs: "",
    body: [
      `<g class="rise"><polygon points="36,36 400,28 392,220 420,228 388,288 30,280" fill="${INK}"/><text x="64" y="76" font-family="${DISPLAY}" font-size="26" fill="${PAPER}" textLength="300" lengthAdjust="spacingAndGlyphs">FAST ENGLISH IN</text></g>`,
      `<g class="rise" style="animation-delay:.1s" font-family="${DISPLAY}" fill="${ORANGE}"><text x="330" y="120" font-size="34" transform="rotate(8 330,120)">?</text><text x="52" y="160" font-size="26" transform="rotate(-9 52,160)">?</text></g>`,
      `<g opacity=".55" transform="translate(9,5)">${noise}</g>`,
      noise,
      `<g class="rise" style="animation-delay:.15s" font-family="${MONO}" font-size="15" fill="${PAPER}"><rect x="60" y="216" width="300" height="28" fill="${INK}"/><text x="74" y="236">overlapping &#183; accented &#183; fast</text></g>`,
      `<g class="flow"><line x1="428" y1="160" x2="500" y2="160" stroke="${ORANGE}" stroke-width="8" stroke-dasharray="14 14"/><polygon points="500,138 536,160 500,182" fill="${ORANGE}"/></g>`,
      `<g class="rise" style="animation-delay:.25s"><polygon points="548,36 864,28 856,220 884,228 852,288 540,280" fill="${PAPER}"/><polygon points="548,36 864,28 856,220 884,228 852,288 540,280" fill="none" stroke="${INK}" stroke-width="6"/><polygon points="600,288 640,288 610,312" fill="${PAPER}"/><text x="576" y="76" font-family="${DISPLAY}" font-size="26" fill="${INK}">CONTEXT OUT</text></g>`,
      clear,
      `<g font-family="${MONO}" font-size="15" font-weight="700" fill="${INK}"><text x="560" y="238">Mari pastikan dulu masalahnya</text><text x="560" y="260">bukan di jaringan.</text></g>`,
      `<g class="rise" style="animation-delay:.4s"><rect x="560" y="272" width="196" height="24" fill="${ORANGE}"/><text x="570" y="290" font-family="${MONO}" font-size="14" font-weight="700" fill="${INK}">ILLUSTRATIVE MOCK</text></g>`,
    ].join("\n"),
  });
};

function capabilityPanel({ x, y, index, title, lines, status, statusFill, statusText, tail }) {
  const w = 410;
  const h = 118;
  const tilt = index % 2 === 0 ? -1.2 : 1.2;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const items = lines
    .map(
      (line, i) =>
        `<text x="${x + 20}" y="${y + 68 + i * 22}" font-family="${MONO}" font-size="15" fill="${PAPER}">${esc(line)}</text>`,
    )
    .join("\n");
  const bubble =
    tail === true
      ? `<polygon points="${x + 60},${y + h - 4} ${x + 104},${y + h - 4} ${x + 72},${y + h + 22}" fill="${INK}"/>`
      : "";
  return [
    `<g class="rise" style="animation-delay:${(index * 0.12).toFixed(2)}s"><g transform="rotate(${tilt} ${cx} ${cy})">`,
    `<polygon points="${x},${y} ${x + w},${y + 8} ${x + w - 10},${y + h} ${x + 6},${y + h - 8}" fill="${INK}"/>`,
    `<text x="${x + 20}" y="${y + 38}" font-family="${DISPLAY}" font-size="25" fill="${ACID}" textLength="250" lengthAdjust="spacingAndGlyphs">${esc(title)}</text>`,
    items,
    bubble,
    `<g transform="rotate(-4 ${x + w - 66} ${y + 25})"><rect x="${x + w - 122}" y="${y + 12}" width="108" height="27" fill="${statusFill}" stroke="${INK}" stroke-width="3"/><text x="${x + w - 112}" y="${y + 32}" font-family="${MONO}" font-size="15" font-weight="700" fill="${statusText}">${esc(status)}</text></g>`,
    `</g></g>`,
  ].join("\n");
}

assets["capabilities.svg"] = () =>
  doc({
    width: 900,
    height: 380,
    label:
      "Capabilities. Live captions, contextual translation, comprehension recovery, and personal vocabulary — all planned; foundation shipped in 0.1.0.",
    title: "Urbuddy capabilities",
    css: BASE_CSS,
    defs: halftone("cap-dots", INK),
    body: [
      `<rect width="900" height="380" fill="url(#cap-dots)" opacity=".5"/>`,
      capabilityPanel({
        x: 36,
        y: 24,
        index: 0,
        title: "LIVE CAPTIONS",
        lines: ["bilingual streaming panels,", "revision-stable"],
        status: "PLANNED",
        statusFill: PAPER,
        statusText: INK,
      }),
      capabilityPanel({
        x: 454,
        y: 24,
        index: 1,
        title: "TRANSLATION",
        lines: ["contextual EN to ID,", "negation-safe"],
        status: "PLANNED",
        statusFill: PAPER,
        statusText: INK,
      }),
      capabilityPanel({
        x: 36,
        y: 158,
        index: 2,
        title: "CATCH-UP",
        lines: ["missed-context recovery,", "grounded answers"],
        status: "PLANNED",
        statusFill: PAPER,
        statusText: INK,
        tail: true,
      }),
      capabilityPanel({
        x: 454,
        y: 158,
        index: 3,
        title: "VOCABULARY",
        lines: ["personal difficulty model,", "spaced repetition"],
        status: "PLANNED",
        statusFill: PAPER,
        statusText: INK,
      }),
      `<g class="rise" style="animation-delay:.5s"><rect x="36" y="296" width="828" height="56" fill="${ACID}"/><rect x="36" y="296" width="828" height="56" fill="none" stroke="${INK}" stroke-width="5"/><text x="56" y="331" font-family="${MONO}" font-size="17" font-weight="700" fill="${INK}" textLength="790" lengthAdjust="spacingAndGlyphs">SHIPPED IN ${APP_VERSION}: typed errors, config, lifecycle, CLI, smoke</text></g>`,
    ].join("\n"),
  });

assets["architecture.svg"] = () => {
  const chain = [
    { x: 30, label: "CAPTURE", sub: "swift helper" },
    { x: 205, label: "PERCEPTION", sub: "streaming STT" },
    { x: 380, label: "LANGUAGE", sub: "translation" },
  ];
  const fork = [
    { x: 640, y: 40, label: "TERMINAL", sub: "ink TUI" },
    { x: 640, y: 128, label: "EVIDENCE", sub: "sqlite journal" },
  ];
  const chainBoxes = chain
    .map(
      (s, i) =>
        `<g class="rise" style="animation-delay:${(i * 0.1).toFixed(2)}s"><rect x="${s.x}" y="40" width="150" height="78" fill="${PAPER}"/><rect x="${s.x}" y="40" width="150" height="78" fill="none" stroke="${INK}" stroke-width="5"/><text x="${s.x + 12}" y="74" font-family="${DISPLAY}" font-size="19" fill="${INK}">${s.label}</text><text x="${s.x + 12}" y="100" font-family="${MONO}" font-size="14" fill="${INK}">${s.sub}</text></g>`,
    )
    .join("\n");
  const chainLinks = chain
    .slice(0, -1)
    .map(
      (s) =>
        `<line class="flow" x1="${s.x + 150}" y1="79" x2="${s.x + 175}" y2="79" stroke="${ACID}" stroke-width="6" stroke-dasharray="14 14"/>`,
    )
    .join("\n");
  const forkBoxes = fork
    .map(
      (s, i) =>
        `<g class="rise" style="animation-delay:${(0.3 + i * 0.1).toFixed(2)}s"><rect x="${s.x}" y="${s.y}" width="220" height="64" fill="${PAPER}"/><rect x="${s.x}" y="${s.y}" width="220" height="64" fill="none" stroke="${INK}" stroke-width="5"/><text x="${s.x + 12}" y="${s.y + 28}" font-family="${DISPLAY}" font-size="19" fill="${INK}">${s.label}</text><text x="${s.x + 12}" y="${s.y + 50}" font-family="${MONO}" font-size="14" fill="${INK}">${s.sub}</text></g>`,
    )
    .join("\n");
  return doc({
    width: 900,
    height: 360,
    label:
      "Architecture. Capture to perception to language, forking to terminal and evidence as separate consumers; intelligence, memory, and learning stay off the hot path.",
    title: "Urbuddy signal flow",
    css: BASE_CSS,
    defs: "",
    body: [
      `<rect x="0" y="0" width="900" height="360" fill="${INK}"/>`,
      `<text x="40" y="30" font-family="${DISPLAY}" font-size="24" fill="${ACID}">SIGNAL FLOW</text>`,
      chainLinks,
      `<line class="flow" x1="530" y1="79" x2="628" y2="66" stroke="${ACID}" stroke-width="6" stroke-dasharray="14 14"/>`,
      `<line class="flow" x1="530" y1="79" x2="628" y2="156" stroke="${ACID}" stroke-width="6" stroke-dasharray="14 14"/>`,
      chainBoxes,
      forkBoxes,
      `<g class="rise" style="animation-delay:.55s" font-family="${MONO}" font-size="13" font-weight="700">`,
      `<rect x="40" y="216" width="264" height="58" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="56" y="241" fill="${PAPER}">INTELLIGENCE, supervisory</text><text x="56" y="262" fill="${SMOKE}">off hot path</text>`,
      `<rect x="318" y="216" width="264" height="58" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="334" y="241" fill="${PAPER}">MEMORY, graphiti sidecar</text><text x="334" y="262" fill="${SMOKE}">derived, rebuildable</text>`,
      `<rect x="596" y="216" width="264" height="58" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="612" y="241" fill="${PAPER}">LEARNING, fsrs</text><text x="612" y="262" fill="${SMOKE}">measured progress</text>`,
      `</g>`,
      `<g class="rise" style="animation-delay:.7s"><rect x="40" y="288" width="820" height="48" fill="${ORANGE}"/><text x="60" y="319" font-family="${MONO}" font-size="16" font-weight="700" fill="${INK}" textLength="780" lengthAdjust="spacingAndGlyphs">data plane keeps running when intelligence, memory, or learning fail</text></g>`,
    ].join("\n"),
  });
};

assets["roadmap.svg"] = () => {
  const steps = loadRoadmapSteps();
  const stateFill = { DONE: ACID, NEXT: ORANGE };
  const chips = steps
    .map(({ name, state }, i) => {
      const fill = stateFill[state] ?? PAPER;
      const label = i === 0 ? `${state} ${APP_VERSION}` : state;
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 36 + col * 280;
      const y = 30 + row * 84;
      return `<g class="rise" style="animation-delay:${(i * 0.08).toFixed(2)}s"><rect x="${x}" y="${y}" width="256" height="64" fill="${fill}"/><rect x="${x}" y="${y}" width="256" height="64" fill="none" stroke="${INK}" stroke-width="5"/><text x="${x + 14}" y="${y + 28}" font-family="${DISPLAY}" font-size="17" fill="${INK}" textLength="228" lengthAdjust="spacingAndGlyphs">${esc(name)}</text><text x="${x + 14}" y="${y + 50}" font-family="${MONO}" font-size="14" font-weight="700" fill="${INK}">${esc(label)}</text></g>`;
    })
    .join("\n");
  return doc({
    width: 900,
    height: 300,
    label: "Roadmap. Foundation done, Core Runtime next, seven milestones planned.",
    title: "Urbuddy roadmap",
    css: BASE_CSS,
    defs: "",
    body: [chips],
  });
};

assets["footer.svg"] = () => {
  const bars = waveBars({
    x: 60,
    y: 118,
    width: 780,
    count: 52,
    maxH: 52,
    seed: 4242,
    color: ACID,
  });
  return doc({
    width: 900,
    height: 180,
    label: "Closing. Hear, understand, respond, evolve.",
    title: "Urbuddy — hear, understand, respond, evolve",
    css: BASE_CSS,
    defs: halftone("foot-dots", INK),
    body: [
      `<rect width="900" height="180" fill="url(#foot-dots)" opacity=".45"/>`,
      bars,
      `<g class="rise"><polygon points="225,18 675,12 669,58 231,62" fill="${INK}"/><text x="247" y="47" font-family="${DISPLAY}" font-size="22" fill="${PAPER}" textLength="420" lengthAdjust="spacingAndGlyphs">HEAR &#183; UNDERSTAND &#183; RESPOND &#183; EVOLVE</text></g>`,
      `<g class="rise" style="animation-delay:.15s"><polygon points="352,108 560,104 554,162 346,164" fill="${PAPER}"/><polygon points="352,108 560,104 554,162 346,164" fill="none" stroke="${INK}" stroke-width="5"/>${wordmark({ x: 372, y: 114, scale: 0.4, top: INK, bottom: ORANGE, dx: 4, dy: 5 })}<circle cx="548" cy="152" r="7" fill="${ORANGE}"/></g>`,
    ].join("\n"),
  });
};

mkdirSync(outDir, { recursive: true });
for (const [name, build] of Object.entries(assets)) {
  writeFileSync(resolve(outDir, name), build(), "utf8");
}
console.log(`brand: wrote ${Object.keys(assets).length} assets to assets/brand/`);
