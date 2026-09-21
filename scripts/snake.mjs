#!/usr/bin/env node
/**
 * Growing snake for a GitHub profile README.
 *
 *  1. The snake roams freely (no fixed sweep) and eats the contribution cells
 *     from the LOWEST level to the HIGHEST (level 1 -> 2 -> 3 -> 4), like snk.
 *  2. It grows a little with every cell it eats.
 *  3. When everything is eaten it goes for its own tail and bites it.
 *  4. "GAME OVER" appears, then everything resets and the loop starts again.
 *
 * Output (same names the Platane/snk action uses, so the README needs no change):
 *   <out>/github-contribution-grid-snake.svg
 *   <out>/github-contribution-grid-snake-dark.svg
 *
 * Usage:
 *   node snake.mjs --user auth-menn --out dist
 *   node snake.mjs --mock --out dist            random data, works offline
 *
 * Options:
 *   --step 0.03      seconds per cell (default: auto, aims for --target seconds)
 *   --target 45      wanted duration of the eating part in seconds (auto step)
 *   --max-len 28     maximum snake length
 *   --hold 3.5       seconds the GAME OVER screen stays
 *   --frame N        write a static debug picture of step N instead
 *   --dump file      write the planned route as JSON (for testing)
 *
 * No dependencies, Node 18+.
 */
import fs from "node:fs";
import path from "node:path";

/* ───────────────────────── options ───────────────────────── */
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
};
const USER = opt("user", process.env.GITHUB_REPOSITORY_OWNER || "auth-menn");
const OUT = opt("out", "dist");
const MOCK = opt("mock", false) === true;
const SEED = Number(opt("seed", 42));
const EMPTY = Number(opt("empty", 0.4)); // mock only: share of empty cells
const TARGET_SEC = Number(opt("target", 45));
const STEP_OPT = opt("step", "auto");
const HOLD_SEC = Number(opt("hold", 3.5));
const FADE_SEC = 0.8;
const MAX_LEN = Number(opt("max-len", 28));
const FRAME = opt("frame", null);
const DUMP = opt("dump", null);

/* ───────────────────────── layout ───────────────────────── */
const COLS = 52; // weeks shown
const ROWS = 7;
const MIN_LEN = 4;
const CELL = 12;
const GAP = 3;
const PITCH = CELL + GAP;
const PAD = 15;
const W = PAD * 2 + COLS * PITCH - GAP;
const H = PAD * 2 + ROWS * PITCH - GAP;

const THEMES = {
  light: {
    file: "github-contribution-grid-snake.svg",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    head: "#5a32a3",
    tail: "#b9a3e3",
    eyeWhite: "#ffffff",
    eyePupil: "#1f2328",
    panel: "#ffffff",
    over: "#cf222e",
    bg: "#ffffff",
  },
  dark: {
    file: "github-contribution-grid-snake-dark.svg",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    head: "#d2a8ff",
    tail: "#7d4ed4",
    eyeWhite: "#ffffff",
    eyePupil: "#1f2328",
    panel: "#0d1117",
    over: "#ff7b72",
    bg: "#0d1117",
  },
};

/* ───────────────────────── data ───────────────────────── */
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function viaGraphQL(user, token) {
  const query = `query($u:String!){user(login:$u){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionLevel weekday}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "growing-snake" },
    body: JSON.stringify({ query, variables: { u: user } }),
  });
  const json = await res.json();
  const weeks = json?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!res.ok || json.errors || !weeks) throw new Error(`GraphQL ${res.status} ${JSON.stringify(json.errors ?? "")}`);
  return weeks.map((w) => {
    const col = Array(ROWS).fill(null);
    for (const d of w.contributionDays) col[d.weekday] = LEVEL[d.contributionLevel] ?? 0;
    return col;
  });
}

async function viaHtml(user) {
  const res = await fetch(`https://github.com/users/${user}/contributions`, { headers: { "User-Agent": "growing-snake" } });
  if (!res.ok) throw new Error(`contributions page ${res.status}`);
  const html = await res.text();
  const tags = html.match(/<td\b[^>]*data-date="[^"]+"[^>]*>/g) || [];
  if (!tags.length) throw new Error("no contribution cells found in HTML");
  const days = tags
    .map((t) => ({ date: /data-date="([^"]+)"/.exec(t)[1], level: Number(/data-level="(\d)"/.exec(t)?.[1] ?? 0) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const DAY = 86400000;
  const first = new Date(days[0].date + "T00:00:00Z");
  const start = first.getTime() - first.getUTCDay() * DAY;
  const weeks = [];
  for (const d of days) {
    const t = new Date(d.date + "T00:00:00Z");
    const w = Math.floor((t.getTime() - start) / (7 * DAY));
    weeks[w] ??= Array(ROWS).fill(null);
    weeks[w][t.getUTCDay()] = d.level;
  }
  return weeks;
}

async function fetchWeeks(user) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    try {
      return await viaGraphQL(user, token);
    } catch (e) {
      console.warn("GraphQL failed, falling back to HTML:", e.message);
    }
  }
  return viaHtml(user);
}

function mockWeeks() {
  let seed = SEED;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  return Array.from({ length: 53 }, (_, w) =>
    Array.from({ length: ROWS }, (_, d) => {
      if (w === 52 && d > 3) return null;
      const r = rnd();
      const q = (r - EMPTY) / (1 - EMPTY);
      return r < EMPTY ? 0 : q < 0.42 ? 1 : q < 0.72 ? 2 : q < 0.88 ? 3 : 4;
    })
  );
}

function toGrid(weeks) {
  const w = weeks.slice(-COLS);
  while (w.length < COLS) w.unshift(Array(ROWS).fill(0));
  return w; // grid[col][row] -> level | null (a day that does not exist yet)
}

/* ───────────────────────── route planner ───────────────────────── */
const N = COLS * ROWS;
const cid = (c, r) => c * ROWS + r;
const colOf = (i) => Math.floor(i / ROWS);
const rowOf = (i) => i % ROWS;
const dist = (a, b) => Math.abs(colOf(a) - colOf(b)) + Math.abs(rowOf(a) - rowOf(b));
const NB = Array.from({ length: N }, (_, i) => {
  const c = colOf(i);
  const r = rowOf(i);
  const out = [];
  if (c + 1 < COLS) out.push(cid(c + 1, r));
  if (r + 1 < ROWS) out.push(cid(c, r + 1));
  if (c > 0) out.push(cid(c - 1, r));
  if (r > 0) out.push(cid(c, r - 1));
  return out;
});

/**
 * Plans the whole game.
 * The snake is the last `L` cells of the route Q. Rules:
 *  - it eats only the lowest level that is still left, nearest cell first
 *  - it never enters its own body (a cell is free again once the tail has left it)
 *  - it grows by one cell now and then (tail stays for one step)
 *  - at the end it heads for a cell next to its own tail = the bite
 */
function plan(grid, maxLenLimit = MAX_LEN) {
  const lvl = new Int8Array(N);
  for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) lvl[cid(c, r)] = grid[c][r] || 0;

  // start on an empty cell at the left edge
  let start = cid(0, 3);
  outer: for (let c = 0; c < COLS; c++) for (const r of [3, 2, 4, 1, 5, 0, 6]) if (lvl[cid(c, r)] === 0) { start = cid(c, r); break outer; }
  lvl[start] = 0;

  const pending = new Uint8Array(N);
  const left = [0, 0, 0, 0, 0];
  let total = 0;
  for (let i = 0; i < N; i++) if (lvl[i] > 0) { pending[i] = 1; left[lvl[i]]++; total++; }
  const maxLen = Math.max(MIN_LEN, Math.min(maxLenLimit, MIN_LEN + total));

  const Q = [start];
  const last = new Int32Array(N).fill(-1);
  last[start] = 0;
  const lens = [MIN_LEN];
  const eatStep = new Int32Array(N).fill(-1);
  let L = MIN_LEN;
  let eaten = 0;

  const search = (goal, tmax, accept) => {
    const s0 = Q.length - 1;
    const root = { id: Q[s0], t: 0, parent: null };
    if (goal(root, s0)) return root;
    const seen = new Set([root.id * (tmax + 1)]);
    let frontier = [root];
    for (let t = 1; t <= tmax && frontier.length; t++) {
      const g = s0 + t;
      const next = [];
      for (const n of frontier)
        for (const nb of NB[n.id]) {
          const key = nb * (tmax + 1) + t;
          if (seen.has(key)) continue;
          const li = last[nb];
          if (li >= 0 && li >= g - L) continue; // covered by the body (the tail cell counts as covered)
          let blocked = false;
          for (let m = n; m && s0 + m.t >= g - L; m = m.parent)
            if (m.id === nb) { blocked = true; break; }
          if (blocked) continue;
          seen.add(key);
          const node = { id: nb, t, parent: n };
          if (goal(node, s0)) {
            if (!accept || accept(node)) return node;
            continue; // a rejected target is treated as a wall
          }
          next.push(node);
        }
      frontier = next;
    }
    return null;
  };

  const chainOf = (node) => {
    const chain = [];
    for (let m = node; m.parent; m = m.parent) chain.push(m.id);
    return chain.reverse();
  };

  // Would the snake still be able to keep moving after eating this cell?
  // (pretend to eat it, look for a collision-free escape route, then undo)
  const growthAfter = (n) => MIN_LEN + Math.floor((n * (maxLen - MIN_LEN)) / total);
  const safe = (node) => {
    const chain = chainOf(node);
    const savedLast = chain.map((c) => last[c]);
    const savedLen = Q.length;
    const savedL = L;
    for (const c of chain) { Q.push(c); last[c] = Q.length - 1; lens.push(L); }
    L = growthAfter(eaten + 1);
    const need = Math.min(L + 6, 40);
    const ok = !!search((n) => n.t >= need, 60);
    for (let i = chain.length - 1; i >= 0; i--) last[chain[i]] = savedLast[i];
    Q.length = savedLen;
    lens.length = savedLen;
    L = savedL;
    return ok;
  };

  const append = (node) => {
    const chain = chainOf(node);
    for (const cell of chain) {
      Q.push(cell);
      last[cell] = Q.length - 1;
      lens.push(L);
    }
    return chain.length;
  };

  // emergency move when no route exists: step to the free neighbour with the most room
  const wander = () => {
    const s0 = Q.length - 1;
    const g = s0 + 1;
    const free = (c) => !(last[c] >= 0 && last[c] >= g - L);
    let best = -1;
    let bestArea = -1;
    for (const nb of NB[Q[s0]]) {
      if (!free(nb)) continue;
      const seen = new Set([nb]);
      const stack = [nb];
      while (stack.length && seen.size < 80) {
        const c = stack.pop();
        for (const x of NB[c]) if (!seen.has(x) && free(x)) { seen.add(x); stack.push(x); }
      }
      if (seen.size > bestArea) { bestArea = seen.size; best = nb; }
    }
    if (best < 0) return false;
    Q.push(best);
    last[best] = Q.length - 1;
    lens.push(L);
    return true;
  };

  // 1) eat: lowest level first, nearest cell first
  let wandered = 0;
  while (eaten < total && wandered < 400) {
    let level = 1;
    while (level <= 4 && left[level] === 0) level++;
    const goal = (n) => pending[n.id] === 1 && lvl[n.id] === level;
    const node = search(goal, 60, safe) || search(goal, 250, safe);
    if (!node) {
      if (!wander()) break;
      wandered++;
      continue;
    }
    append(node);
    pending[node.id] = 0;
    left[level]--;
    eaten++;
    eatStep[node.id] = Q.length - 1;
    L = growthAfter(eaten);
    lens[lens.length - 1] = L;
  }

  // 2) the bite: get the head next to the tail
  const tailOf = (n, s0, g) => {
    const ti = g - L + 1;
    if (ti <= s0) return Q[ti];
    let m = n;
    for (let k = g - ti; k > 0; k--) m = m.parent;
    return m.id;
  };
  const biteGoal = (n, s0) => {
    const g = s0 + n.t;
    if (g < L - 1) return false;
    return dist(n.id, tailOf(n, s0, g)) === 1;
  };
  let bite = search(biteGoal, 300);
  for (let k = 0; !bite && k < 200; k++) {
    if (!wander()) break;
    bite = search(biteGoal, 300);
  }
  if (!bite) throw new Error("the snake could not reach its tail (try another --max-len)");
  append(bite);

  return { Q, lens, eatStep, L, S: Q.length - 1, total, eaten, lvl };
}

/* ───────────────────────── helpers ───────────────────────── */
const cx = (c) => PAD + c * PITCH + CELL / 2;
const cy = (r) => PAD + r * PITCH + CELL / 2;
const xyId = (i) => [cx(colOf(i)), cy(rowOf(i))];
const angleId = (a, b) => (Math.atan2(rowOf(b) - rowOf(a), colOf(b) - colOf(a)) * 180) / Math.PI; // right 0, down 90
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => "#" + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, "0")).join("");
const r2 = (n) => Math.round(n * 100) / 100;

/* ───────────────────────── pixel "GAME OVER" ───────────────────────── */
const FONT = {
  G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
};

function gameOverSvg(theme, id) {
  const text = "GAME OVER";
  const u = 8; // size of one "pixel"
  let x = 0;
  const glyphs = [];
  for (const ch of text) {
    if (ch === " ") { x += 3; continue; }
    glyphs.push([FONT[ch], x]);
    x += 6;
  }
  const widthUnits = x - 1;
  const w = widthUnits * u;
  const h = 7 * u;
  const ox = (W - w) / 2;
  const oy = (H - h) / 2;
  let d = "";
  for (const [rows, gx] of glyphs)
    rows.forEach((row, ry) => [...row].forEach((v, rx) => { if (v === "#") d += `M${r2(ox + (gx + rx) * u)} ${r2(oy + ry * u)}h${u - 1}v${u - 1}h-${u - 1}z`; }));
  const pw = w + 48;
  const ph = h + 30;
  return (
    `<g id="${id}" class="a" style="animation-name:go;opacity:0">` +
    `<rect x="${r2((W - pw) / 2)}" y="${r2((H - ph) / 2)}" width="${r2(pw)}" height="${ph}" rx="6" fill="${theme.panel}" fill-opacity=".92" stroke="${theme.over}" stroke-width="2"/>` +
    `<path d="${d}" fill="${theme.over}"/></g>`
  );
}

/* ───────────────────────── SVG ───────────────────────── */
function build(P0, theme, mode) {
  const { Q, lens, eatStep, L: SEG, S } = P0;

  // timeline, unit = one step (the head crosses one cell per step)
  const STEP = STEP_OPT === "auto" ? Math.min(0.07, Math.max(0.02, TARGET_SEC / S)) : Number(STEP_OPT);
  const HOLD_END = S + Math.max(SEG + 4, Math.round(HOLD_SEC / STEP)); // GAME OVER stays until here
  const FADE_END = HOLD_END + Math.max(8, Math.round(FADE_SEC / STEP));
  const TOTAL = FADE_END + SEG + 2; // last SEG steps: parked, invisible (lets the delayed body wrap around)
  const DUR = TOTAL * STEP;
  const pc = (t) => (100 * t) / TOTAL;
  const fmt = (p) => p.toFixed(4) + "%";
  const EPS = 0.0002; // percent, an instant jump between two keyframes

  // route continues around the loop after the bite, so head and body keep circling together
  const P = Q.slice();
  for (let k = 1; P.length <= FADE_END; k++) P.push(P[S + k - SEG]);

  // when does segment j appear?
  const appear = (j) => lens.findIndex((v) => v > j);

  if (mode.frame !== null) return frameSvg(P0, theme, P, Math.min(mode.frame, FADE_END));

  const dur = r2(DUR * 1000) / 1000;
  let css = `.a{animation-duration:${dur}s;animation-timing-function:linear;animation-iteration-count:infinite;transform-box:view-box;transform-origin:0 0}`;
  const eatOf = (c, r) => eatStep[cid(c, r)];
  let cells = "";
  const empty = theme.levels[0];

  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++) {
      const lv = P0.lvl[cid(c, r)];
      const x = PAD + c * PITCH;
      const y = PAD + r * PITCH;
      const shape = `x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2"`;
      if (lv === 0) {
        if (P0.gridRaw[c][r] !== null) cells += `<rect ${shape} fill="${empty}"/>`;
        continue;
      }
      const color = theme.levels[lv];
      const es = eatOf(c, r);
      if (es < 0) { cells += `<rect ${shape} fill="${color}"/>`; continue; } // never eaten (fallback)
      const id = `e${c}_${r}`;
      const tEat = Math.max(es - 0.5, 0.3);
      css += `@keyframes ${id}{0%,${fmt(pc(tEat))}{fill:${color}}${fmt(pc(tEat) + EPS)},${fmt(pc(HOLD_END))}{fill:${empty}}${fmt(pc(FADE_END))},100%{fill:${color}}}`;
      cells += `<rect class="a" style="animation-name:${id}" ${shape} fill="${color}"/>`;
    }

  // shared route for every body segment (each one just runs it a bit later)
  const corner = (i) => {
    if (i === 0 || i === FADE_END) return true;
    const a = P[i - 1], b = P[i], c = P[i + 1];
    return colOf(b) - colOf(a) !== colOf(c) - colOf(b) || rowOf(b) - rowOf(a) !== rowOf(c) - rowOf(b);
  };
  let route = "";
  for (let i = 0; i <= FADE_END; i++) if (corner(i)) { const [x, y] = xyId(P[i]); route += `${fmt(pc(i))}{transform:translate(${r2(x)}px,${r2(y)}px)}`; }
  {
    // (everything is hidden by now) jump back to the start cell so the next loop can begin
    const [x, y] = xyId(P[0]);
    route += `${fmt(pc(FADE_END) + EPS)}{transform:translate(${r2(x)}px,${r2(y)}px)}100%{transform:translate(${r2(x)}px,${r2(y)}px)}`;
  }
  css += `@keyframes r{${route}}`;

  const fadeOut = `${fmt(pc(HOLD_END))}{opacity:1}${fmt(pc(FADE_END))},100%{opacity:0}`;
  css += `@keyframes o0{0%,${fadeOut}}`;
  for (let j = MIN_LEN; j < SEG; j++) {
    const a = appear(j);
    css += `@keyframes o${j}{0%,${fmt(pc(a - 1))}{opacity:0}${fmt(pc(a))},${fadeOut}}`;
  }

  // head: same route + heading + chomp
  let cur = 0;
  const turnTo = (t) => { cur += ((t - cur + 540) % 360) - 180; };
  const hk = [];
  const addH = (p, x, y, sc, extra = "") => hk.push(`${fmt(p)}{transform:translate(${r2(x)}px,${r2(y)}px) rotate(${r2(cur)}deg) scale(${sc})${extra}}`);
  const forced = new Map([[HOLD_END, ";opacity:1"], [FADE_END, ";opacity:0"]]);
  for (const k of [S, S + 1, S + 2]) if (!forced.has(k)) forced.set(k, "");
  const a0 = angleId(P[0], P[1]);
  for (let i = 0; i <= FADE_END; i++) {
    const out = i < FADE_END ? angleId(P[i], P[i + 1]) : angleId(P[i - 1], P[i]);
    const inn = i > 0 ? angleId(P[i - 1], P[i]) : out;
    const turn = Math.abs(out - inn) > 1e-6;
    if (i === 0) { turnTo(out); }
    if (i === 0 || turn || forced.has(i)) {
      const [x, y] = xyId(P[i]);
      const extra = forced.get(i) ?? "";
      addH(pc(i), x, y, 1, extra);
      if (turn && i > 0) { turnTo(out); addH(pc(i) + EPS, x, y, 1, extra); }
    }
    if ((i === S || i === S + 1) && i < FADE_END) { // chomp, chomp
      const [x, y] = xyId(P[i]);
      const [x2, y2] = xyId(P[i + 1]);
      addH(pc(i + 0.5), (x + x2) / 2, (y + y2) / 2, 1.4);
    }
  }
  {
    const [x, y] = xyId(P[0]);
    cur = 0; turnTo(a0);
    addH(pc(FADE_END) + EPS, x, y, 1, ";opacity:0");
    addH(100, x, y, 1, ";opacity:0");
  }
  css += `@keyframes h{${hk.join("")}}`;
  css += `@keyframes go{0%,${fmt(pc(S + 1.5))}{opacity:0}${fmt(pc(S + 2.5))},${fmt(pc(HOLD_END))}{opacity:1}${fmt(pc(FADE_END))},100%{opacity:0}}`;

  let body = "";
  const segSize = (j) => CELL - (5 * j) / Math.max(1, SEG - 1);
  const segRx = (j) => 3 - (1.3 * j) / Math.max(1, SEG - 1);
  for (let j = SEG - 1; j >= 1; j--) {
    const [x0, y0] = xyId(P[0]);
    const sz = segSize(j);
    const delay = r2((DUR - j * STEP) * 10000) / 10000; // negative delay = same route, j steps behind
    const anim = `animation:r ${dur}s linear -${delay}s infinite,o${j < MIN_LEN ? 0 : j} ${dur}s linear infinite`;
    body += `<rect style="${anim}" transform="translate(${r2(x0)} ${r2(y0)})" x="${r2(-sz / 2)}" y="${r2(-sz / 2)}" width="${r2(sz)}" height="${r2(sz)}" rx="${r2(segRx(j))}" fill="${mix(theme.head, theme.tail, j / Math.max(1, SEG - 1))}"/>`;
  }
  const [hx0, hy0] = xyId(P[0]);
  body += `<g class="a" style="animation-name:h" transform="translate(${r2(hx0)} ${r2(hy0)}) rotate(${r2(a0)})">${headShape(theme)}</g>`;

  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><style>${css}</style>${cells}${body}${gameOverSvg(theme, "over")}</svg>\n`,
    meta: { STEP, S, HOLD_END, FADE_END, TOTAL, DUR, SEG, P },
  };
}

function headShape(theme) {
  return (
    `<rect x="-6" y="-6" width="12" height="12" rx="3.2" fill="${theme.head}"/>` +
    `<circle cx="2.2" cy="-3" r="2.1" fill="${theme.eyeWhite}"/><circle cx="2.2" cy="3" r="2.1" fill="${theme.eyeWhite}"/>` +
    `<circle cx="2.9" cy="-3" r="1" fill="${theme.eyePupil}"/><circle cx="2.9" cy="3" r="1" fill="${theme.eyePupil}"/>`
  );
}

// static picture of one moment (debug only)
function frameSvg(P0, theme, P, s) {
  const { lens, eatStep, L: SEG, S } = P0;
  const len = lens[Math.min(s, S)];
  let out = "";
  for (let c = 0; c < COLS; c++)
    for (let r = 0; r < ROWS; r++) {
      if (P0.gridRaw[c][r] === null) continue;
      const es = eatStep[cid(c, r)];
      const eaten = es >= 0 && es <= s;
      out += `<rect x="${PAD + c * PITCH}" y="${PAD + r * PITCH}" width="${CELL}" height="${CELL}" rx="2" fill="${theme.levels[eaten ? 0 : P0.lvl[cid(c, r)]]}"/>`;
    }
  for (let j = len - 1; j >= 1; j--) {
    const [x, y] = xyId(P[Math.max(0, s - j)]);
    const sz = CELL - (5 * j) / Math.max(1, SEG - 1);
    out += `<rect x="${r2(x - sz / 2)}" y="${r2(y - sz / 2)}" width="${r2(sz)}" height="${r2(sz)}" rx="2.5" fill="${mix(theme.head, theme.tail, j / Math.max(1, SEG - 1))}"/>`;
  }
  const [x, y] = xyId(P[s]);
  out += `<g transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(angleId(P[s], P[s + 1] ?? P[s]))})">${headShape(theme)}</g>`;
  if (s >= S + 2) out += gameOverSvg(theme, "over").replace('class="a" style="animation-name:go;opacity:0"', "");
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="100%" height="100%" fill="${theme.bg}"/>${out}</svg>\n`, meta: {} };
}

/* ───────────────────────── self check ───────────────────────── */
function verify(p) {
  const { Q, lens, S, L } = p;
  for (let i = 1; i < Q.length; i++) if (dist(Q[i - 1], Q[i]) !== 1) throw new Error(`route jump at ${i}`);
  for (let s = 0; s <= S; s++) {
    const len = lens[s];
    if (s > 0 && lens[s] - lens[s - 1] > 1) throw new Error(`grows too fast at ${s}`);
    const cells = Q.slice(Math.max(0, s - len + 1), s + 1);
    if (new Set(cells).size !== cells.length) throw new Error(`snake overlaps itself at step ${s}`);
  }
  if (dist(Q[S], Q[S - L + 1]) !== 1) throw new Error("head does not end next to the tail");
}

/* ───────────────────────── main ───────────────────────── */
const weeks = MOCK ? mockWeeks() : await fetchWeeks(USER);
const grid = toGrid(weeks);
// rare unlucky layouts can trap the snake: retry with a slightly shorter snake until everything gets eaten
let planned = null;
for (const limit of [MAX_LEN, MAX_LEN - 4, MAX_LEN - 8, MAX_LEN - 12, MAX_LEN - 16]) {
  if (limit < 8) break;
  try {
    const p = plan(grid, limit);
    verify(p);
    if (!planned || p.eaten > planned.eaten) planned = p;
    if (p.eaten === p.total) break;
  } catch (e) {
    if (limit === MAX_LEN - 16 && !planned) throw e;
  }
}
if (!planned) throw new Error("could not plan a route");
planned.gridRaw = grid;
fs.mkdirSync(OUT, { recursive: true });

const eatenPct = Math.round((100 * planned.eaten) / Math.max(1, planned.total));
if (FRAME !== null) {
  for (const [name, theme] of Object.entries(THEMES)) {
    const { svg } = build(planned, theme, { frame: Number(FRAME) });
    fs.writeFileSync(path.join(OUT, `frame-${name}-${FRAME}.svg`), svg);
  }
  console.log(`debug frames written for step ${FRAME} (bite at ${planned.S})`);
} else {
  let meta;
  for (const theme of Object.values(THEMES)) {
    const built = build(planned, theme, { frame: null });
    meta = built.meta;
    fs.writeFileSync(path.join(OUT, theme.file), built.svg);
    console.log(`${theme.file}  ${(built.svg.length / 1024).toFixed(0)} KB`);
  }
  console.log(`ate ${planned.eaten}/${planned.total} cells (${eatenPct}%), ${planned.S} steps, snake ${MIN_LEN} -> ${planned.L}`);
  console.log(`loop: ${r2(meta.DUR)}s (${r2(meta.STEP * 1000)} ms per cell), bite at ${r2(meta.S * meta.STEP)}s, game over until ${r2(meta.HOLD_END * meta.STEP)}s`);
  if (DUMP) fs.writeFileSync(DUMP, JSON.stringify({ ...meta, P: meta.P.map((i) => [colOf(i), rowOf(i)]), lens: planned.lens }));
}
