import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "assets", "brand");

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
    y: 368,
    width: 780,
    count: 52,
    maxH: 32,
    seed: 20261126,
    color: ACID,
  });
  return doc({
    width: 900,
    height: 400,
    label: "Urbuddy hero. Break the language barrier. Hear, understand, respond, evolve.",
    title: "Urbuddy — break the language barrier",
    css: BASE_CSS,
    defs: halftone("hero-dots", PAPER),
    body: [
      `<rect width="900" height="400" fill="url(#hero-dots)"/>`,
      burst({ cx: 810, cy: 70, rays: 14, r0: 26, r1: 66, color: ORANGE, width: 6 }),
      `<g class="rise"><polygon points="48,40 640,28 628,150 660,158 600,300 616,308 560,372 40,360" fill="${PAPER}"/><polygon points="48,40 640,28 628,150 660,158 600,300 616,308 560,372 40,360" fill="none" stroke="${INK}" stroke-width="6"/></g>`,
      `<g class="rise" style="animation-delay:.12s" font-family="${DISPLAY}" fill="${INK}">`,
      `<text x="84" y="132" font-size="72">BREAK THE</text>`,
      `<text x="84" y="206" font-size="72">LANGUAGE</text>`,
      `<text x="84" y="280" font-size="72" fill="${ORANGE}">BARRIER.</text>`,
      `</g>`,
      `<g class="rise" style="animation-delay:.24s"><polygon points="636,212 852,200 844,268 628,278" fill="${INK}"/><text x="656" y="248" font-family="${DISPLAY}" font-size="30" fill="${ACID}">urbuddy</text></g>`,
      `<g class="rise" style="animation-delay:.34s" font-family="${MONO}" font-size="19" font-weight="700" fill="${PAPER}">`,
      `<rect x="60" y="296" width="560" height="32" fill="${INK}"/>`,
      `<text x="76" y="320">HEAR &#183; UNDERSTAND &#183; RESPOND &#183; EVOLVE</text>`,
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
      `<g class="rise"><polygon points="36,36 400,28 392,220 420,228 388,288 30,280" fill="${INK}"/><text x="64" y="76" font-family="${DISPLAY}" font-size="26" fill="${PAPER}">FAST ENGLISH IN</text></g>`,
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

function capabilityPanel({ x, y, index, title, lines, status, statusFill, statusText }) {
  const w = 410;
  const h = 118;
  const items = lines
    .map(
      (line, i) =>
        `<text x="${x + 20}" y="${y + 66 + i * 22}" font-family="${MONO}" font-size="15" fill="${PAPER}">${esc(line)}</text>`,
    )
    .join("\n");
  return [
    `<g class="rise" style="animation-delay:${(index * 0.12).toFixed(2)}s">`,
    `<polygon points="${x},${y} ${x + w},${y + 6} ${x + w - 8},${y + h} ${x},${y + h - 6}" fill="${INK}"/>`,
    `<text x="${x + 20}" y="${y + 36}" font-family="${DISPLAY}" font-size="25" fill="${ACID}">${esc(title)}</text>`,
    items,
    `<rect x="${x + w - 118}" y="${y + 12}" width="104" height="26" fill="${statusFill}"/><text x="${x + w - 108}" y="${y + 31}" font-family="${MONO}" font-size="15" font-weight="700" fill="${statusText}">${esc(status)}</text>`,
    `</g>`,
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
      `<g class="rise" style="animation-delay:.5s"><rect x="36" y="296" width="828" height="56" fill="${ACID}"/><rect x="36" y="296" width="828" height="56" fill="none" stroke="${INK}" stroke-width="5"/><text x="56" y="331" font-family="${MONO}" font-size="17" font-weight="700" fill="${INK}">SHIPPED IN 0.1.0: typed errors, config, lifecycle, CLI, smoke</text></g>`,
    ].join("\n"),
  });

assets["architecture.svg"] = () => {
  const stages = [
    { x: 40, label: "CAPTURE", sub: "swift helper" },
    { x: 216, label: "PERCEPTION", sub: "streaming STT" },
    { x: 392, label: "LANGUAGE", sub: "translation" },
    { x: 568, label: "TERMINAL", sub: "ink TUI" },
    { x: 744, label: "EVIDENCE", sub: "sqlite" },
  ];
  const boxes = stages
    .map(
      (s, i) =>
        `<g class="rise" style="animation-delay:${(i * 0.1).toFixed(2)}s"><rect x="${s.x}" y="60" width="140" height="86" fill="${PAPER}"/><rect x="${s.x}" y="60" width="140" height="86" fill="none" stroke="${INK}" stroke-width="5"/><text x="${s.x + 12}" y="98" font-family="${DISPLAY}" font-size="19" fill="${INK}">${s.label}</text><text x="${s.x + 12}" y="124" font-family="${MONO}" font-size="14" fill="${INK}">${s.sub}</text></g>`,
    )
    .join("\n");
  const links = stages
    .slice(0, -1)
    .map(
      (s) =>
        `<line class="flow" x1="${s.x + 140}" y1="103" x2="${s.x + 176}" y2="103" stroke="${ACID}" stroke-width="6" stroke-dasharray="14 14"/>`,
    )
    .join("\n");
  return doc({
    width: 900,
    height: 340,
    label:
      "Architecture. Capture to perception to language to terminal and evidence; intelligence, memory, and learning stay off the hot path.",
    title: "Urbuddy signal flow",
    css: BASE_CSS,
    defs: "",
    body: [
      `<rect x="0" y="0" width="900" height="340" fill="${INK}"/>`,
      `<text x="40" y="40" font-family="${DISPLAY}" font-size="26" fill="${ACID}">SIGNAL FLOW</text>`,
      links,
      boxes,
      `<g class="rise" style="animation-delay:.55s" font-family="${MONO}" font-size="14" font-weight="700">`,
      `<rect x="40" y="176" width="264" height="60" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="56" y="202" fill="${PAPER}">INTELLIGENCE, supervisory</text><text x="56" y="224" fill="${SMOKE}">off hot path</text>`,
      `<rect x="318" y="176" width="264" height="60" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="334" y="202" fill="${PAPER}">MEMORY, graphiti sidecar</text><text x="334" y="224" fill="${SMOKE}">derived, rebuildable</text>`,
      `<rect x="596" y="176" width="264" height="60" fill="none" stroke="${SMOKE}" stroke-width="3" stroke-dasharray="8 6"/><text x="612" y="202" fill="${PAPER}">LEARNING, fsrs</text><text x="612" y="224" fill="${SMOKE}">measured progress</text>`,
      `</g>`,
      `<g class="rise" style="animation-delay:.7s"><rect x="40" y="258" width="820" height="52" fill="${ORANGE}"/><text x="60" y="292" font-family="${MONO}" font-size="17" font-weight="700" fill="${INK}">data plane keeps running when intelligence, memory, or learning fail</text></g>`,
    ].join("\n"),
  });
};

assets["roadmap.svg"] = () => {
  const steps = [
    ["FOUNDATION", "DONE v0.1.0", ACID, INK],
    ["CORE RUNTIME", "NEXT", ORANGE, INK],
    ["PERCEPTION", "PLANNED", PAPER, INK],
    ["LANGUAGE", "PLANNED", PAPER, INK],
    ["TERMINAL", "PLANNED", PAPER, INK],
    ["INTELLIGENCE", "PLANNED", PAPER, INK],
    ["MEMORY", "PLANNED", PAPER, INK],
    ["LEARNING", "PLANNED", PAPER, INK],
    ["QUALIFICATION", "PLANNED", PAPER, INK],
  ];
  const chips = steps
    .map(([name, state, fill, text], i) => {
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = 36 + col * 280;
      const y = 30 + row * 84;
      return `<g class="rise" style="animation-delay:${(i * 0.08).toFixed(2)}s"><rect x="${x}" y="${y}" width="256" height="64" fill="${fill}"/><rect x="${x}" y="${y}" width="256" height="64" fill="none" stroke="${INK}" stroke-width="5"/><text x="${x + 14}" y="${y + 28}" font-family="${DISPLAY}" font-size="20" fill="${text}">${name}</text><text x="${x + 14}" y="${y + 50}" font-family="${MONO}" font-size="14" font-weight="700" fill="${text}">${state}</text></g>`;
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
      `<g class="rise"><polygon points="225,18 675,12 669,58 231,62" fill="${INK}"/><text x="247" y="47" font-family="${DISPLAY}" font-size="22" fill="${PAPER}">HEAR &#183; UNDERSTAND &#183; RESPOND &#183; EVOLVE</text></g>`,
      `<g class="rise" style="animation-delay:.15s"><text x="386" y="158" font-family="${DISPLAY}" font-size="34" fill="${INK}">urbuddy<tspan fill="${ORANGE}">.</tspan></text></g>`,
    ].join("\n"),
  });
};

mkdirSync(outDir, { recursive: true });
for (const [name, build] of Object.entries(assets)) {
  writeFileSync(resolve(outDir, name), build(), "utf8");
}
console.log(`brand: wrote ${Object.keys(assets).length} assets to assets/brand/`);
