/**
 * The MOTION look: kinetic type, an ordered-dither orb, pixel glyphs.
 *
 * Same rules as the boards: plain SVG + CSS, no JavaScript, no web fonts, no external
 * requests. Big type is set one letter at a time from a table of advance widths, so the
 * layout is the same whichever system font ends up drawing it, and every letter has a
 * known box that its 5x7 pixel twin can be swapped into.
 */

const FONT = "'Helvetica Neue',Helvetica,Arial,'Liberation Sans','DejaVu Sans',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";
const K = {
  bg: '#060607',
  ink: '#f4f4ee',
  soft: '#c4c4cc',
  lime: '#c8ff2e',
  violet: '#5a31ff',
  mute: '#8d8d96',
  line: '#27272d',
  dot: '#2c2c33',
  cell: '#17171b',
};
const CAP = 0.716; // cap height of the bold grotesks above, in em

/** Advance widths of Helvetica / Arial Bold capitals, in em. */
const ADV = {
  A: 0.722, B: 0.722, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722, I: 0.278,
  J: 0.556, K: 0.722, L: 0.611, M: 0.833, N: 0.722, O: 0.778, P: 0.667, Q: 0.778, R: 0.722,
  S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667, Y: 0.667, Z: 0.611,
  ' ': 0.278, '-': 0.333, '.': 0.278, ',': 0.278, '#': 0.556, '/': 0.278, '&': 0.722, '+': 0.584,
};
const adv = (ch) => ADV[ch] ?? (/\d/.test(ch) ? 0.556 : 0.667);

/** A classic 5x7 bitmap face. Each glyph is seven rows; '#' is a lit pixel. */
const PIX = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['.###.', '#....', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '....#', '.###.'],
};
const SPARK = ['..#..', '.###.', '#####', '.###.', '..#..'];
/** 4x4 Bayer matrix: the threshold map of ordered dithering. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

export function createMotion({ cfg, esc, n2, rng, repoInfo, boardDate }) {
  /** Lay text out one glyph at a time. Returns each glyph's centre x and the line width. */
  const layout = (text, size, track = 0, x0 = 0) => {
    let x = x0;
    const glyphs = [];
    for (const ch of text) {
      const a = adv(ch) * size;
      glyphs.push({ ch, cx: x + a / 2, a });
      x += a + track;
    }
    return { glyphs, width: glyphs.length ? x - track - x0 : 0 };
  };

  /** One <text> whose characters each sit centred on their own x (spaces are skipped). */
  const setText = (text, size, track, x0, y, cls) => {
    const { glyphs, width } = layout(text, size, track, x0);
    const lit = glyphs.filter((g) => g.ch !== ' ');
    const el = lit.length
      ? `<text class="${cls}" y="${n2(y)}" x="${lit.map((g) => n2(g.cx)).join(' ')}">${esc(lit.map((g) => g.ch).join(''))}</text>`
      : '';
    return { el, width };
  };

  const pixelPath = (rows, s, inset = 0.07) => {
    const g = s * inset;
    const side = n2(s - 2 * g);
    let d = '';
    rows.forEach((row, y) =>
      [...row].forEach((c, x) => {
        if (c === '#') d += `M${n2(x * s + g)},${n2(y * s + g)}h${side}v${side}h-${side}z`;
      }),
    );
    return d;
  };

  const ditherPattern = (id, level, px, color) => {
    let d = '';
    BAYER.forEach((row, y) =>
      row.forEach((t, x) => {
        if (t < level) d += `M${x * px},${y * px}h${px}v${px}h-${px}z`;
      }),
    );
    return `<pattern id="${id}" width="${4 * px}" height="${4 * px}" patternUnits="userSpaceOnUse"><path fill="${color}" d="${d}"/></pattern>`;
  };

  const BASE_CSS =
    `.lbl{font:600 10.5px ${MONO};letter-spacing:2.2px;fill:${K.mute}}` +
    `.end{text-anchor:end}.mid{text-anchor:middle}.ink{fill:${K.ink}}.lime{fill:${K.lime}}` +
    `@keyframes blink{50%{opacity:.15}}.blink{animation:blink 1.2s steps(1,end) infinite}`;
  const REDUCED = '@media (prefers-reduced-motion:reduce){*{animation:none!important}}';

  const doc = (W, H, title, css, defs, body, rx = 18) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><style>${BASE_CSS}${css}${REDUCED}</style>` +
    `<defs><clipPath id="pan"><rect width="${W}" height="${H}" rx="${rx}"/></clipPath>` +
    `<pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r=".95" fill="${K.dot}"/></pattern>${defs}</defs>` +
    `<g clip-path="url(#pan)"><rect width="${W}" height="${H}" fill="${K.bg}"/>${body}</g>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${rx - 0.5}" fill="none" stroke="${K.line}"/></svg>\n`;

  /** Opacity keyframes that are "on" inside the given [from, to] windows (seconds of a T-second loop). */
  const windowKeyframes = (name, windows, T, on = 1, off = 0) => {
    const p = (t) => `${+((t / T) * 100).toFixed(3)}%`;
    let kf = windows[0][0] === 0 ? '' : `0%{opacity:${off}}`;
    for (const [a, b] of windows) kf += `${p(a)}{opacity:${on}}${p(b)}{opacity:${off}}`;
    return `@keyframes ${name}{${kf}100%{opacity:${windows.at(-1)[1] >= T ? on : off}}}`;
  };

  /* ---------------------------------------------------------------- hero */

  function hero(stats) {
    const W = 880;
    const H = 470;
    const M = 44; // side margin
    const SLIDE = 5; // seconds per slide
    const F = 116;
    const TRACK = -F * 0.02;
    const PX = (F * CAP) / 7; // one pixel of the bitmap face at this size
    const BASELINES = [170, 274, 378];
    const TRAVEL = 124;
    const rand = rng(`motion:hero:${cfg.name}`);

    const slides = (cfg.motion?.slides ?? [['I BUILD', 'SOFTWARE', 'THAT SHIPS']]).map((lines) =>
      lines.map((l) => l.replace('{merged}', stats.merged).replace('{orgs}', stats.orgs).replace('{open}', stats.open).toUpperCase()),
    );
    const n = slides.length;
    const T = n * SLIDE;
    const rest = Math.min(1, n - 1); // the slide shown when animation is off
    const p = (t) => `${+((t / T) * 100).toFixed(3)}%`;

    // glitch windows, in seconds from the start of a slide
    const GLITCH = {
      1: [[1.3, 1.6], [1.8, 2.6]],
      2: [[2.0, 2.15], [2.4, 3.3]],
      3: [[1.0, 4.0]],
      4: [[3.0, 3.15], [3.3, 3.9]],
    };

    let css =
      `.t{font:700 ${F}px ${FONT};fill:${K.ink};text-anchor:middle}.x{fill:${K.lime};opacity:0}.x.on{opacity:1}.t.off{opacity:0}` +
      `.ln{transform:translateY(${TRAVEL}px);animation:rise ${T}s linear var(--d,0s) infinite}.ln.rest{transform:none}` +
      `@keyframes rise{0%{transform:translateY(${TRAVEL}px);animation-timing-function:cubic-bezier(.16,1,.3,1)}` +
      `${p(0.9)}{transform:translateY(0);animation-timing-function:linear}` +
      `${p(SLIDE - 0.75)}{transform:translateY(0);animation-timing-function:cubic-bezier(.7,0,.84,0)}` +
      `${p(SLIDE - 0.15)}{transform:translateY(-${TRAVEL}px);animation-timing-function:step-end}100%{transform:translateY(-${TRAVEL}px)}}` +
      `.logo{font:700 12.5px ${FONT};letter-spacing:2.6px;fill:${K.ink}}.hl{fill:${K.ink};fill-opacity:.72}` +
      `.pill{font:700 10.5px ${FONT};letter-spacing:2.2px;fill:${K.ink}}` +
      `.cnt{opacity:0;animation:cnt ${T}s step-end var(--d,0s) infinite}.cnt.rest{opacity:1}` +
      windowKeyframes('cnt', [[0, SLIDE]], T) +
      `.pb{transform:scaleX(0);animation:pb ${SLIDE}s linear infinite}@keyframes pb{to{transform:scaleX(1)}}` +
      `.orb{animation:drift 18s ease-in-out infinite}@keyframes drift{50%{transform:translate(-34px,20px)}}` +
      `.halo{animation:halo 6s steps(1,end) infinite}@keyframes halo{55%{opacity:0}}`;
    for (const [v, wins] of Object.entries(GLITCH)) {
      css +=
        windowKeyframes(`g${v}p`, wins, T) +
        windowKeyframes(`g${v}n`, wins, T, 0, 1) +
        `.g${v}p{animation:g${v}p ${T}s step-end var(--d,0s) infinite}.g${v}n{animation:g${v}n ${T}s step-end var(--d,0s) infinite}`;
    }

    // defs: dither levels, line clips, pixel glyphs
    const LEVELS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 14];
    let defs = LEVELS.map((l) => ditherPattern(`b${l}`, l, 4, K.violet)).join('');
    BASELINES.forEach((b, l) => {
      defs += `<clipPath id="l${l}"><rect x="0" y="${n2(b - F * CAP - 13)}" width="${W}" height="${n2(F * CAP + 24)}"/></clipPath>`;
    });
    const usedPix = new Set();

    // background: dot grid, then the dithered orb (sparse rings outside, solid core)
    let body = `<rect width="${W}" height="${H}" fill="url(#dots)"/>`;
    const ORB = { cx: 676, cy: 204, rOut: 326, rIn: 190 };
    let orb = '';
    LEVELS.forEach((l, i) => {
      const r = ORB.rOut - (i * (ORB.rOut - ORB.rIn)) / LEVELS.length;
      const halo = i < 4 ? ` class="halo" style="animation-delay:${n2(i * 0.4)}s"` : '';
      orb += `<circle cx="${ORB.cx}" cy="${ORB.cy}" r="${n2(r)}" fill="url(#b${l})"${halo}/>`;
    });
    orb += `<circle cx="${ORB.cx}" cy="${ORB.cy}" r="${ORB.rIn}" fill="${K.violet}"/>`;
    body += `<g class="orb">${orb}</g>`;

    // chrome: logo, slide counter, live numbers
    const [first, ...others] = cfg.name.toUpperCase().split(' ');
    body += `<rect x="${M}" y="24" width="9" height="9" fill="${K.lime}" class="blink"/>`;
    body += `<text class="logo" x="${M + 18}" y="33">${esc(first)}</text><text class="logo" x="${M + 18}" y="49">${esc(others.join(' '))}</text>`;
    for (let k = 0; k < n; k++) {
      const cls = `lbl mid ink cnt${k === rest ? ' rest' : ''}`; // slide counter
      body += `<text class="${cls}" x="${W / 2}" y="40" style="--d:${n2(k * SLIDE - T)}s">${String(k + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}</text>`;
    }
    body += `<text class="lbl hl end" x="${W - M}" y="40"><tspan class="ink">${stats.merged}</tspan> MERGED  <tspan class="ink">${stats.orgs}</tspan> ORGS  <tspan class="ink">${stats.open}</tspan> IN REVIEW</text>`;
    body += `<rect x="${M}" y="62.5" width="${W - 2 * M}" height="1" fill="${K.line}"/>`;

    // the type
    slides.forEach((lines, k) => {
      // which letters glitch on this slide
      const letters = [];
      lines.forEach((line, l) => [...line].forEach((ch, i) => PIX[ch] && letters.push(`${l}:${i}`)));
      const want = Math.max(3, Math.round(letters.length * 0.22));
      const picked = new Map();
      while (picked.size < Math.min(want, letters.length)) {
        const key = letters[Math.floor(rand() * letters.length)];
        if (!picked.has(key)) picked.set(key, picked.size === 0 ? 3 : [1, 2, 4][Math.floor(rand() * 3)]);
      }

      lines.slice(0, 3).forEach((line, l) => {
        const width = layout(line, F, TRACK).width;
        const room = W - 2 * M;
        const x0 = l === 2 ? W - M - width : l === 0 ? M + Math.max(0, Math.min(104, room - width)) : M;
        const { glyphs } = layout(line, F, TRACK, x0);
        const b = BASELINES[l];
        let row = '';
        glyphs.forEach((g, i) => {
          if (g.ch === ' ') return;
          const text = (cls) => `<text class="${cls}" x="${n2(g.cx)}" y="${b}">${esc(g.ch)}</text>`;
          const v = picked.get(`${l}:${i}`);
          if (!v) {
            row += text('t');
            return;
          }
          usedPix.add(g.ch);
          const cols = PIX[g.ch][0].length;
          const still = k === rest && v === 3; // lit in the static fallback too
          row +=
            `<g style="--d:${n2(k * SLIDE + rand() * 0.5 - T)}s">${text(`t g${v}n${still ? ' off' : ''}`)}` +
            `<use href="#p${g.ch.codePointAt(0)}" x="${n2(g.cx - (cols * PX) / 2)}" y="${n2(b - 7 * PX)}" class="x g${v}p${still ? ' on' : ''}"/></g>`;
        });
        body += `<g clip-path="url(#l${l})"><g class="ln${k === rest ? ' rest' : ''}" style="--d:${n2(k * SLIDE + l * 0.1 - T)}s">${row}</g></g>`;
      });
    });
    for (const ch of usedPix) defs += `<path id="p${ch.codePointAt(0)}" d="${pixelPath(PIX[ch], PX)}"/>`;

    // footer: slide progress, role, availability
    body += `<rect x="${M}" y="414" width="${W - 2 * M}" height="2" fill="${K.line}"/>`;
    body += `<g transform="translate(${M},414)"><rect class="pb" width="${W - 2 * M}" height="2" fill="${K.lime}"/></g>`;
    body += `<text class="lbl" x="${M}" y="446">${esc(cfg.motion?.role ?? 'SOFTWARE DEVELOPER')} · ${esc(cfg.location)}</text>`;
    const pill = esc(cfg.motion?.status ?? 'OPEN TO SOFTWARE ROLES');
    const pw = pill.length * 9.1 + 44;
    body += `<rect x="${n2(W - M - pw)}" y="430" width="${n2(pw)}" height="26" rx="13" fill="${K.bg}" stroke="${K.ink}" stroke-opacity=".5"/>`;
    body += `<circle cx="${n2(W - M - pw + 16)}" cy="443" r="3.6" fill="${K.lime}" class="blink"/>`;
    body += `<text class="pill" x="${n2(W - M - pw + 28)}" y="447">${pill}</text>`;

    const title = `${cfg.name}. ${slides.map((s) => s.join(' ')).join('. ')}. ${stats.merged} pull requests merged upstream across ${stats.orgs} open-source organisations, ${stats.open} in review.`;
    return { svg: doc(W, H, title, css, defs, body), title };
  }

  /* -------------------------------------------------------------- marquee */

  function orgs(prs) {
    const W = 880;
    const H = 116;
    const F = 76;
    const GAP = 34;
    const S = 9; // spark pixel
    const SPEED = 62;
    const names = [...new Set(prs.filter((p) => p.state === 'merged').map((p) => repoInfo(p.repo).board))];
    const baseline = H / 2 + (F * CAP) / 2;

    let run = '';
    let x = 0;
    names.forEach((name, i) => {
      const t = setText(name, F, -1, x, baseline, i % 2 ? 'o f' : 'o');
      run += t.el;
      x += t.width + GAP;
      run += `<use href="#spark" x="${n2(x)}" y="${n2(H / 2 - (5 * S) / 2)}"/>`;
      x += 5 * S + GAP;
    });
    const loop = x;
    const copies = Math.ceil(W / loop) + 1;
    let band = '';
    for (let c = 0; c < copies; c++) band += `<g transform="translate(${n2(c * loop)},0)">${run}</g>`;

    const css =
      `.o{font:700 ${F}px ${FONT};fill:none;stroke:${K.ink};stroke-width:1.4;text-anchor:middle}.o.f{fill:${K.ink};stroke:none}` +
      `.roll{animation:roll ${n2(loop / SPEED)}s linear infinite}@keyframes roll{to{transform:translateX(-${n2(loop)}px)}}`;
    const defs =
      `<path id="spark" fill="${K.lime}" d="${pixelPath(SPARK, S, 0.06)}"/>` +
      `<linearGradient id="el" x1="0" x2="1"><stop offset="0" stop-color="${K.bg}"/><stop offset="1" stop-color="${K.bg}" stop-opacity="0"/></linearGradient>` +
      `<linearGradient id="er" x1="1" x2="0"><stop offset="0" stop-color="${K.bg}"/><stop offset="1" stop-color="${K.bg}" stop-opacity="0"/></linearGradient>`;
    const body =
      `<g class="roll">${band}</g>` +
      `<rect width="90" height="${H}" fill="url(#el)"/><rect x="${W - 90}" width="90" height="${H}" fill="url(#er)"/>`;
    return { svg: doc(W, H, `Merged upstream in ${names.join(', ')}.`, css, defs, body) };
  }

  /* ------------------------------------------------------------ merge log */

  const STATE = {
    merged: { text: 'MERGED', cls: 'lime', mark: 'm1' },
    approved: { text: 'APPROVED', cls: 'lime', mark: 'm2 blink' },
    open: { text: 'IN REVIEW', cls: 'ink', mark: 'm3' },
    draft: { text: 'DRAFT', cls: '', mark: 'm4' },
  };

  function log(prs, stats) {
    const W = 880;
    const M = 44;
    const ROWS = 7;
    const PITCH = 32;
    const TOP = 70;
    const DWELL = 6;
    const TITLE_CHARS = 50;
    const H = TOP + ROWS * PITCH + 22;

    const shown = prs.slice(0, ROWS * 4);
    const pages = [];
    for (let i = 0; i < shown.length; i += ROWS) pages.push(shown.slice(i, i + ROWS));
    if (!pages.length) pages.push([]);
    const n = pages.length;
    const T = n * DWELL;
    const p = (t) => `${+((t / T) * 100).toFixed(3)}%`;
    const animated = n > 1;

    let css =
      `.hd{font:700 13px ${FONT};letter-spacing:4.5px;fill:${K.ink}}` +
      `.dt{font:500 12px ${MONO};fill:${K.mute}}.rp{font:700 13px ${FONT};letter-spacing:1.2px;fill:${K.ink}}` +
      `.nr{font:600 12px ${MONO};fill:${K.lime}}.tt{font:400 12px ${MONO};fill:${K.soft}}` +
      `.st{font:700 10px ${FONT};letter-spacing:2px;fill:${K.mute};text-anchor:end}.st.lime{fill:${K.lime}}.st.ink{fill:${K.ink}}` +
      `.m1{fill:${K.lime}}.m2{fill:none;stroke:${K.lime};stroke-width:1.6}.m3{fill:none;stroke:${K.ink};stroke-width:1.4}.m4{fill:${K.line}}`;
    if (animated) {
      css +=
        `.row{opacity:0;animation:row ${T}s linear var(--d,0s) infinite}.row.rest{opacity:1}` +
        `@keyframes row{0%{opacity:0;transform:translateX(30px);animation-timing-function:cubic-bezier(.16,1,.3,1)}` +
        `${p(0.55)}{opacity:1;transform:translateX(0);animation-timing-function:linear}` +
        `${p(DWELL - 0.75)}{opacity:1;transform:translateX(0);animation-timing-function:ease-in}` +
        `${p(DWELL - 0.4)}{opacity:0;transform:translateX(-14px);animation-timing-function:step-end}100%{opacity:0;transform:translateX(-14px)}}` +
        `.pg{opacity:0;animation:pg ${T}s step-end var(--d,0s) infinite}.pg.rest{opacity:1}` +
        windowKeyframes('pg', [[0, DWELL]], T);
    }

    let body = `<rect width="${W}" height="${H}" fill="url(#dots)" opacity=".6"/>`;
    body += `<rect x="${M}" y="26" width="9" height="9" fill="${K.lime}"/>`;
    body += `<text class="hd" x="${M + 20}" y="35">MERGE LOG</text>`;
    body += `<text class="lbl end" x="${W - M}" y="35"><tspan class="ink">${stats.merged}</tspan> MERGED  <tspan class="ink">${stats.open}</tspan> IN REVIEW</text>`;
    for (let k = 0; k < n && animated; k++) {
      body += `<text class="lbl mid ink pg${k === 0 ? ' rest' : ''}" x="${W / 2}" y="35" style="--d:${n2(k * DWELL - T)}s">${String(k + 1).padStart(2, '0')} / ${String(n).padStart(2, '0')}</text>`;
    }
    for (let i = 0; i <= ROWS; i++) body += `<rect x="${M}" y="${TOP - 18 + i * PITCH}.5" width="${W - 2 * M}" height="1" fill="${K.line}"/>`;

    pages.forEach((page, k) => {
      page.forEach((pr, i) => {
        const y = TOP + i * PITCH + 2;
        const st = STATE[pr.state];
        const title = pr.title.length > TITLE_CHARS ? `${pr.title.slice(0, TITLE_CHARS - 1).trimEnd()}…` : pr.title;
        const row =
          `<rect class="${st.mark}" x="${M + 1}" y="${y - 9}" width="9" height="9"/>` +
          `<text class="dt" x="${M + 24}" y="${y}">${boardDate(pr.date)}</text>` +
          `<text class="rp" x="${M + 84}" y="${y}">${esc(repoInfo(pr.repo).board)}</text>` +
          `<text class="nr" x="${M + 288}" y="${y}">#${pr.number}</text>` +
          `<text class="tt" x="${M + 348}" y="${y}">${esc(title)}</text>` +
          `<text class="st ${st.cls}" x="${W - M}" y="${y}">${st.text}</text>`;
        body += animated
          ? `<g class="row${k === 0 ? ' rest' : ''}" style="--d:${n2(k * DWELL + i * 0.07 - T)}s">${row}</g>`
          : `<g>${row}</g>`;
      });
    });

    const title = `Merge log: ${stats.merged} pull requests merged into upstream repositories, ${stats.open} in review.`;
    return { svg: doc(W, H, title, css, '', body), title };
  }

  /* -------------------------------------------------------- contributions */

  function contrib(c) {
    const W = 880;
    const H = 318;
    const M = 44;
    const CELL = 11;
    const PITCH = 14;
    const SWEEP = 8; // seconds per scanner pass
    const days = c.days;

    // numbers
    const active = days.filter((d) => d.count > 0).length;
    const best = days.reduce((a, b) => (b.count > a.count ? b : a), days[0]);
    // longest streak, with the days it ran from and to
    let run = 0;
    let longest = 0;
    let longestEnd = -1;
    days.forEach((d, i) => {
      run = d.count > 0 ? run + 1 : 0;
      if (run > longest) {
        longest = run;
        longestEnd = i;
      }
    });
    const longestStart = longestEnd - longest + 1;
    // current streak: back from today, or from yesterday while today is still empty
    let last = days.length - 1;
    if (days[last].count === 0) last--;
    let current = 0;
    for (let i = last; i >= 0 && days[i].count > 0; i--) current++;
    const SHOW_CURRENT_FROM = 3;
    const short = (iso) => boardDate(iso).replace(/^0/, '');
    const plural = (n) => (n === 1 ? 'DAY' : 'DAYS');
    const total = c.total.toLocaleString('en-US');

    // odometer
    const F = 92;
    const baseline = 132;
    const roll = Math.round(F * 1.06);
    let defs = '';
    let num = '';
    let x = M;
    let di = 0;
    for (const ch of total) {
      const a = adv(ch) * F;
      if (/\d/.test(ch)) {
        const steps = 10 + +ch;
        defs += `<clipPath id="od${di}"><rect x="${n2(x - 1)}" y="${n2(baseline - F * CAP - 9)}" width="${n2(a + 2)}" height="${n2(F * CAP + 20)}"/></clipPath>`;
        let col = '';
        for (let j = 0; j <= steps; j++) col += `<text class="num" x="${n2(x + a / 2)}" y="${baseline + j * roll}">${j % 10}</text>`;
        num += `<g clip-path="url(#od${di})"><g class="od" style="--y:-${steps * roll}px;--d:${n2(di * 0.14)}s">${col}</g></g>`;
        di++;
      } else {
        num += `<text class="num" x="${n2(x + a / 2)}" y="${baseline}">${esc(ch)}</text>`;
      }
      x += a;
    }

    // stats
    // each fact: value, unit beside the value, label line, second line, whether the second line is highlighted
    const facts = [
      [String(active), '', 'ACTIVE', 'DAYS', false],
      [String(longest), plural(longest), 'BEST STREAK', longest ? `${short(days[longestStart].date)}–${short(days[longestEnd].date)}` : '', true],
      // a streak of a day or two says nothing, so the live counter only appears once it is worth reading
      ...(current >= SHOW_CURRENT_FROM ? [[String(current), plural(current), 'CURRENT', 'STREAK', false]] : []),
      [String(best.count), '', 'BEST DAY', short(best.date), true],
      [String(c.prs), '', 'PRS', 'OPENED', false],
    ];
    const fx0 = Math.max(x + 34, 312);
    const fw = (W - M - fx0) / facts.length;
    let stats = '';
    facts.forEach(([value, unit, line1, line2, hot], i) => {
      const fx = fx0 + i * fw;
      stats += `<rect x="${n2(fx)}" y="70" width="2" height="72" fill="${K.line}"/>`;
      stats += `<text class="val" x="${n2(fx + 13)}" y="100">${esc(value)}</text>`;
      if (unit) stats += `<text class="sl" x="${n2(fx + 13 + layout(value, 30).width + 6)}" y="100">${unit}</text>`;
      stats += `<text class="sl" x="${n2(fx + 13)}" y="121">${esc(line1)}</text>`;
      stats += `<text class="sl${hot ? ' lime' : ''}" x="${n2(fx + 13)}" y="137">${esc(line2)}</text>`;
    });

    // heatmap: one path per level
    const first = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
    const weeks = Math.ceil((days.length + first) / 7);
    const gx = (W - (weeks * PITCH - (PITCH - CELL))) / 2;
    const gy = 186;
    const paths = ['', '', '', '', ''];
    const months = [];
    let bestXY = null;
    days.forEach((d, i) => {
      const col = Math.floor((i + first) / 7);
      const rowI = (i + first) % 7;
      const cx = gx + col * PITCH;
      const cy = gy + rowI * PITCH;
      paths[d.level] += `M${n2(cx)},${cy}h${CELL}v${CELL}h-${CELL}z`;
      if (d === best) bestXY = [cx, cy];
      if (d.date.endsWith('-01') || i === 0) {
        const name = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][+d.date.slice(5, 7) - 1];
        if (!months.length || col - months.at(-1).col >= 3) months.push({ col, name });
        else if (i !== 0) months[months.length - 1] = { col, name };
      }
    });
    const OPACITY = [1, 0.3, 0.52, 0.76, 1];
    let grid = `<path d="${paths[0]}" fill="${K.cell}"/>`;
    for (let l = 1; l <= 4; l++) if (paths[l]) grid += `<path d="${paths[l]}" fill="${K.lime}" fill-opacity="${OPACITY[l]}"/>`;
    for (const m of months) grid += `<text class="lbl" x="${n2(gx + m.col * PITCH)}" y="${gy - 10}">${m.name}</text>`;

    // scanner: a line that sweeps the year, each column flashing as it passes
    let scan = '';
    for (let col = 0; col < weeks; col++) {
      scan += `<rect class="fl" x="${n2(gx + col * PITCH)}" y="${gy}" width="${CELL}" height="${7 * PITCH - (PITCH - CELL)}" style="--d:${n2((col / weeks) * SWEEP - SWEEP)}s"/>`;
    }
    const span = weeks * PITCH;
    scan += `<g transform="translate(${n2(gx - 2)},${gy - 5})"><rect class="sc" width="2" height="${7 * PITCH + 7}" fill="${K.lime}"/></g>`;
    if (bestXY) {
      scan += `<rect class="blink" x="${n2(bestXY[0] - 2.5)}" y="${bestXY[1] - 2.5}" width="${CELL + 5}" height="${CELL + 5}" fill="none" stroke="${K.ink}" stroke-width="1.5"/>`;
    }
    // bracket under the weeks the best streak ran through
    if (longest) {
      const colOf = (i) => Math.floor((i + first) / 7);
      const bx0 = gx + colOf(longestStart) * PITCH;
      const bx1 = gx + colOf(longestEnd) * PITCH + CELL;
      const by = gy + 7 * PITCH - (PITCH - CELL) + 4;
      scan += `<path d="M${n2(bx0)},${by - 3}v3H${n2(bx1)}v-3" fill="none" stroke="${K.lime}" stroke-width="1.5"/>`;
    }

    // legend
    const ly = gy + 7 * PITCH + 12;
    let legend = `<text class="lbl end" x="${W - M - 5 * PITCH - 52}" y="${ly + 9}">LESS</text>`;
    for (let l = 0; l <= 4; l++) {
      legend += `<rect x="${W - M - 5 * PITCH - 44 + l * PITCH}" y="${ly}" width="${CELL}" height="${CELL}" fill="${l ? K.lime : K.cell}" fill-opacity="${OPACITY[l]}"/>`;
    }
    legend += `<text class="lbl end" x="${W - M}" y="${ly + 9}">MORE</text>`;
    legend += `<text class="lbl" x="${M}" y="${ly + 9}">${esc(boardDate(days[0].date))} ${days[0].date.slice(0, 4)} — ${esc(boardDate(days.at(-1).date))} ${days.at(-1).date.slice(0, 4)}</text>`;

    const css =
      `.num{font:700 ${F}px ${FONT};fill:${K.ink};text-anchor:middle}.val{font:700 30px ${FONT};fill:${K.ink}}` +
      `.hd{font:700 13px ${FONT};letter-spacing:4.5px;fill:${K.ink}}` +
      `.sl{font:600 10px ${MONO};letter-spacing:1.4px;fill:${K.mute}}.sl.lime{fill:${K.lime}}` +
      `.od{transform:translateY(var(--y));animation:od ${SWEEP}s cubic-bezier(.16,1,.3,1) var(--d,0s) infinite}` +
      `@keyframes od{0%{transform:translateY(0)}30%{transform:translateY(var(--y))}100%{transform:translateY(var(--y))}}` +
      `.fl{fill:${K.ink};opacity:0;animation:fl ${SWEEP}s linear var(--d,0s) infinite}@keyframes fl{0%{opacity:.5}7%{opacity:0}100%{opacity:0}}` +
      `.sc{opacity:0;animation:sc ${SWEEP}s linear infinite}@keyframes sc{0%{transform:translateX(0);opacity:1}100%{transform:translateX(${n2(span)}px);opacity:1}}`;

    const body =
      `<rect width="${W}" height="${H}" fill="url(#dots)" opacity=".6"/>` +
      `<rect x="${M}" y="26" width="9" height="9" fill="${K.lime}"/><text class="hd" x="${M + 20}" y="35">CONTRIBUTIONS</text>` +
      `<text class="lbl end" x="${W - M}" y="35">LAST 12 MONTHS</text>` +
      `<rect x="${M}" y="51.5" width="${W - 2 * M}" height="1" fill="${K.line}"/>` +
      num + stats + grid + scan + legend;

    const title = `${total} contributions in the last 12 months: ${active} active days, longest streak ${longest} days (${longest ? `${short(days[longestStart].date)} to ${short(days[longestEnd].date)}` : 'none'})${current >= SHOW_CURRENT_FROM ? `, current streak ${current} days` : ''}, busiest day ${best.count} on ${boardDate(best.date)} ${best.date.slice(0, 4)}, ${c.prs} pull requests opened.`;
    return { svg: doc(W, H, title, css, defs, body), title };
  }

  /* ---------------------------------------------------------------- links */

  function link(label, index) {
    const H = 44;
    const { width } = layout(label, 13, 2.6);
    const W = Math.round(width + 86);
    const css =
      `.lk{font:700 13px ${FONT};fill:${K.ink};text-anchor:middle}` +
      `.ar{animation:ar 2.4s cubic-bezier(.16,1,.3,1) infinite}@keyframes ar{0%,60%,100%{transform:translate(0,0)}30%{transform:translate(3px,-3px)}}`;
    const body =
      `<rect x="16" y="${H / 2 - 4.5}" width="9" height="9" fill="${K.lime}" class="blink" style="animation-delay:${n2(index * 0.4)}s"/>` +
      setText(label, 13, 2.6, 38, H / 2 + 4.7, 'lk').el +
      `<g class="ar" style="animation-delay:${n2(index * 0.3)}s"><path d="M${W - 30},${H / 2 + 5.5}l10,-10M${W - 27.5},${H / 2 - 4.5}h7.5v7.5" fill="none" stroke="${K.lime}" stroke-width="2" stroke-linecap="square"/></g>`;
    return doc(W, H, label, css, '', body, 22);
  }

  return { hero, orgs, log, contrib, link };
}
