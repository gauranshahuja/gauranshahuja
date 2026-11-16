#!/usr/bin/env node
/**
 * Builds the split-flap boards in assets/ and the generated blocks in README.md.
 *
 * The output is plain SVG + CSS: no JavaScript, no web fonts, no external requests,
 * which is what GitHub allows inside a README image. No npm dependencies. Node 20+.
 *
 *   node scripts/build-board.mjs            fetch live data from the GitHub API, then build
 *   node scripts/build-board.mjs --offline  rebuild from data/prs.json
 *   node scripts/build-board.mjs --use motion    make MOTION.md the profile (or: board, classic)
 *
 * The profile has three versions: MOTION.md, BOARD.md and CLASSIC.md. README.md is always a copy of
 * the active one ("active" in board.config.json), and both carry a switch to the other.
 *
 * Output depends only on the pull-request data, so a run with no new activity
 * produces no diff.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMotion } from './looks/motion.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'prs.json');
const CONTRIB = join(ROOT, 'data', 'contrib.json');
const OFFLINE = process.argv.includes('--offline');
const cfg = JSON.parse(await readFile(join(ROOT, 'board.config.json'), 'utf8'));

/* ------------------------------------------------------------------ data */

async function gh(path) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'profile-board',
  };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${path}`);
  return res.json();
}

/** A maintainer approved it and nobody with write access is asking for changes. */
async function isApproved(repo, number) {
  try {
    const reviews = await gh(`/repos/${repo}/pulls/${number}/reviews?per_page=100`);
    const latest = new Map();
    for (const rv of reviews) {
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(rv.author_association)) continue;
      if (rv.state === 'COMMENTED' || rv.state === 'PENDING') continue;
      latest.set(rv.user?.login, rv.state);
    }
    const states = [...latest.values()];
    return states.includes('APPROVED') && !states.includes('CHANGES_REQUESTED');
  } catch {
    return false; // a missing badge is better than a failed build
  }
}

async function fetchPRs() {
  const q = encodeURIComponent(`type:pr author:${cfg.user} -user:${cfg.user}`);
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const data = await gh(`/search/issues?q=${q}&per_page=100&page=${page}`);
    items.push(...data.items);
    if (data.items.length === 0 || items.length >= data.total_count) break;
  }
  const exclude = new Set((cfg.exclude ?? []).map((s) => s.toLowerCase()));
  const prs = [];
  for (const it of items) {
    const repo = it.repository_url.split('/repos/')[1];
    if (exclude.has(repo.toLowerCase())) continue;
    const merged = it.pull_request?.merged_at;
    if (!merged && it.state !== 'open') continue; // closed without merging
    let state = merged ? 'merged' : it.draft ? 'draft' : 'open';
    if (state === 'open' && (await isApproved(repo, it.number))) state = 'approved';
    prs.push({
      repo,
      number: it.number,
      title: it.title.trim(),
      url: it.html_url,
      state,
      date: (merged ?? it.created_at).slice(0, 10),
    });
  }
  prs.sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);
  return prs;
}

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

/** The contribution calendar of the last 12 months. GitHub only serves it over GraphQL, which needs a token. */
async function fetchContrib() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('no GITHUB_TOKEN / GH_TOKEN set');
  const query =
    'query($login:String!){user(login:$login){contributionsCollection{totalCommitContributions totalIssueContributions ' +
    'totalPullRequestContributions totalPullRequestReviewContributions contributionCalendar{totalContributions ' +
    'weeks{contributionDays{date contributionCount contributionLevel}}}}}}';
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-board' },
    body: JSON.stringify({ query, variables: { login: cfg.user } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 200)}`);
  const c = json.data.user.contributionsCollection;
  return {
    total: c.contributionCalendar.totalContributions,
    commits: c.totalCommitContributions,
    prs: c.totalPullRequestContributions,
    reviews: c.totalPullRequestReviewContributions,
    issues: c.totalIssueContributions,
    days: c.contributionCalendar.weeks
      .flatMap((w) => w.contributionDays)
      .map((d) => ({ date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0 })),
  };
}

/**
 * What each square of the calendar was made of: commit headlines per repository, plus the pull requests,
 * issues and reviews of that day. A commit is dated in the time zone of its own timestamp, which is how
 * GitHub places it on the calendar; PRs, issues and reviews are dated in UTC. Private repositories are
 * never named here: their work only shows up in the day's count.
 */
async function fetchDayLog() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error('no GITHUB_TOKEN / GH_TOKEN set');
  const gql = async (query, variables) => {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-board' },
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (!res.ok || json.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 200)}`);
    return json.data;
  };
  const repo = '{nameWithOwner isPrivate}';
  const top = await gql(
    'query($login:String!){user(login:$login){id contributionsCollection{startedAt endedAt ' +
      `commitContributionsByRepository(maxRepositories:100){repository${repo}} ` +
      `pullRequestContributions(first:100){nodes{occurredAt pullRequest{title number repository${repo}}}} ` +
      `issueContributions(first:100){nodes{occurredAt issue{title number repository${repo}}}} ` +
      `pullRequestReviewContributions(first:100){nodes{occurredAt pullRequest{title number repository${repo}}}}}}}`,
    { login: cfg.user },
  );
  const { id, contributionsCollection: c } = top.user;
  const log = {};
  const day = (date) => (log[date] ??= { commits: {}, events: [] });

  for (const { repository: r } of c.commitContributionsByRepository) {
    if (r.isPrivate) continue;
    const [owner, name] = r.nameWithOwner.split('/');
    let after = null;
    do {
      const d = await gql(
        'query($owner:String!,$name:String!,$id:ID!,$since:GitTimestamp!,$until:GitTimestamp!,$after:String){' +
          'repository(owner:$owner,name:$name){defaultBranchRef{target{... on Commit{' +
          'history(first:100,after:$after,author:{id:$id},since:$since,until:$until){' +
          'pageInfo{hasNextPage endCursor} nodes{authoredDate messageHeadline}}}}}}}',
        { owner, name, id, since: c.startedAt, until: c.endedAt, after },
      );
      const history = d.repository?.defaultBranchRef?.target?.history;
      if (!history) break;
      // authoredDate keeps the commit's own offset, so its first ten characters are the calendar day
      for (const n of history.nodes) (day(n.authoredDate.slice(0, 10)).commits[r.nameWithOwner] ??= []).unshift(n.messageHeadline);
      after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    } while (after);
  }

  const events = [
    ...c.pullRequestContributions.nodes.map((n) => [n, n.pullRequest, 'opened PR']),
    ...c.issueContributions.nodes.map((n) => [n, n.issue, 'opened issue']),
    ...c.pullRequestReviewContributions.nodes.map((n) => [n, n.pullRequest, 'reviewed PR']),
  ];
  for (const [n, item, verb] of events.sort((a, b) => a[0].occurredAt.localeCompare(b[0].occurredAt))) {
    if (item.repository.isPrivate) continue;
    day(n.occurredAt.slice(0, 10)).events.push(`${verb} ${item.repository.nameWithOwner}#${item.number}: ${item.title}`);
  }
  return Object.fromEntries(Object.keys(log).sort().map((k) => [k, log[k]]));
}

/** daylog.json keeps one day per line as well. */
const dayLogJson = (log) =>
  `{\n${Object.entries(log).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',\n')}\n}\n`;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The "Day by day" block under the chart: one collapsible month per section, newest first. */
function dayLogMarkdown(days, log) {
  const active = days.filter((d) => d.count > 0);
  if (!active.length) return '';
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\s+/g, ' ').trim();
  const repoLabel = (r) => (r.startsWith(`${cfg.user}/`) ? r.slice(cfg.user.length + 1) : r);
  const months = new Map();
  for (const d of active) {
    const key = d.date.slice(0, 7);
    if (!months.has(key)) months.set(key, []);
    months.get(key).push(d);
  }
  const sections = [...months.entries()].reverse().map(([key, list], i) => {
    const [y, m] = key.split('-').map(Number);
    const total = list.reduce((s, d) => s + d.count, 0);
    const rows = list
      .slice()
      .reverse()
      .map((d) => {
        const entry = log[d.date];
        const parts = [];
        for (const [r, heads] of Object.entries(entry?.commits ?? {})) {
          const more = heads.length > 3 ? ` (+${heads.length - 3} more)` : '';
          parts.push(`**${cell(repoLabel(r))}**: ${heads.slice(0, 3).map(cell).join('; ')}${more}`);
        }
        for (const e of entry?.events ?? []) parts.push(cell(e));
        const date = new Date(`${d.date}T00:00:00Z`);
        const label = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_NAMES[m - 1].slice(0, 3)}`;
        return `| ${label} | ${d.count} | ${parts.length ? parts.join('<br>') : 'no public details'} |`;
      });
    return (
      `<details${i === 0 ? ' open' : ''}>\n<summary>${MONTH_NAMES[m - 1]} ${y} · ${list.length} active days · ${total} contributions</summary>\n\n` +
      `| Day | Count | What |\n|---|--:|---|\n${rows.join('\n')}\n\n</details>`
    );
  });
  return `<details>\n<summary><b>Day by day</b>: what each square on the chart was</summary>\n<br>\n\n${sections.join('\n\n')}\n\n</details>`;
}

/** contrib.json keeps one day per line, so the daily diff is readable. */
const contribJson = (c) => {
  const { days, ...totals } = c;
  const rows = days.map((d) => JSON.stringify([d.date, d.count, d.level])).join(',\n');
  return `${JSON.stringify(totals).slice(0, -1)},"days":[\n${rows}\n]}\n`;
};

/* ----------------------------------------------------------------- utils */

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n2 = (n) => +(+n).toFixed(2);
const pad2 = (n) => String(n).padStart(2, '0');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const boardDate = (iso) => `${iso.slice(8, 10)} ${MONTHS[+iso.slice(5, 7) - 1]}`;
const proseDate = (iso) => {
  const m = MONTHS[+iso.slice(5, 7) - 1];
  return `${+iso.slice(8, 10)} ${m[0]}${m.slice(1).toLowerCase()} ${iso.slice(0, 4)}`;
};

/** Deterministic PRNG, so the "random" scramble glyphs are the same on every run. */
function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const repoInfo = (repo) => {
  const known = cfg.repos?.[repo];
  const name = repo.split('/')[1];
  return {
    board: (known?.board ?? name.replace(/[-_.]+/g, ' ')).toUpperCase().slice(0, 18),
    prose: known?.prose ?? name,
    heading: known?.heading ?? repo,
  };
};

/* ---------------------------------------------------------------- design */

const FONT = "'Helvetica Neue',Helvetica,Arial,'Liberation Sans','DejaVu Sans',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono','DejaVu Sans Mono',monospace";
const C = {
  housing: '#0c0e12',
  edge: '#2c313a',
  rail: '#161920',
  top: '#262a33',
  bot: '#1d2027',
  ink: '#f4f1e8',
  soft: '#c5cbd3',
  amber: '#ffc233',
  green: '#3ddc84',
  mute: '#8b949e',
  dim: '#3d434d',
};
const GAP = 0.75; // half of the slit between the two halves of a flap

const PLATE_GRADIENTS =
  `<linearGradient id="pT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d323c"/><stop offset="1" stop-color="${C.top}"/></linearGradient>` +
  `<linearGradient id="pB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#181b21"/><stop offset=".35" stop-color="${C.bot}"/><stop offset="1" stop-color="#21252d"/></linearGradient>`;

/** Flap sizes: cell width/height, font size, corner radius, ink colour. */
const SIZES = {
  L: { w: 50, h: 68, fs: 48, r: 5, fill: C.ink },
  M: { w: 31, h: 44, fs: 27, r: 3.5, fill: C.amber },
  S: { w: 24, h: 32, fs: 20, r: 2.5, fill: C.ink },
  D: { w: 24, h: 32, fs: 20, r: 2.5, fill: C.mute }, // S, unlit
};
const SCRAMBLE = 'ABCDEFGHJKLNOPRSTUVXYZ23456789';

/**
 * One SVG document's worth of split-flap machinery.
 *
 * A "sequence" is a looping list of states. Every animated cell shows one glyph per
 * state, and each change is a real two-part flip: the top half of the old glyph
 * falls (scaleY 1 -> 0 on the hinge), then the bottom half of the new glyph lands
 * (scaleY 0 -> 1). Cells and rows are drawn with the hinge at y = 0, so the scale
 * needs no transform-origin. All cells of a sequence share its keyframes and are
 * staggered with a negative animation-delay passed down as the --d custom property.
 *
 * With animations off (prefers-reduced-motion, or a renderer that ignores CSS
 * animation) every cell rests on the sequence's `rest` state.
 */
class Kit {
  constructor() {
    this.glyphs = new Map(); // "L:65" -> { size, ch }
    this.seqs = new Map();
    this.extraDefs = [];
    this.extraCss = [];
  }

  seq(name, { starts, period, flip, rest }) {
    this.seqs.set(name, { starts, period, flip, rest, n: starts.length });
    return name;
  }

  /** Negative delay that makes a looping element flip into state 0 `offset` seconds after load. */
  delay(seqName, offset) {
    return n2(offset - this.seqs.get(seqName).period);
  }

  #glyph(size, ch) {
    const code = ch.codePointAt(0);
    this.glyphs.set(`${size}:${code}`, { size, ch });
    return code;
  }

  /** A flap cell centred on (cx, hingeY) that steps through `glyphs`, one per state. */
  cell(size, cx, hy, glyphs, seqName, delay) {
    const codes = glyphs.map((g) => this.#glyph(size, g));
    if (new Set(codes).size === 1 || !seqName) {
      const c = codes[seqName ? 0 : codes.length - 1];
      return `<use href="#${size}t${c}" x="${n2(cx)}" y="${n2(hy)}"/><use href="#${size}b${c}" x="${n2(cx)}" y="${n2(hy)}"/>`;
    }
    const n = codes.length;
    let s = `<g transform="translate(${n2(cx)},${n2(hy)})" style="--d:${delay}s">`;
    for (let k = 0; k < n; k++) {
      s += `<use href="#${size}t${codes[k]}" class="${seqName}t${k}"/><use href="#${size}b${codes[k]}" class="${seqName}b${k}"/>`;
    }
    for (let k = 0; k < n; k++) {
      if (codes[k] !== codes[(k + 1) % n]) s += `<use href="#${size}t${codes[k]}" class="${seqName}x${k}"/>`;
      if (codes[k] !== codes[(k - 1 + n) % n]) s += `<use href="#${size}b${codes[k]}" class="${seqName}y${k}"/>`;
    }
    return s + '</g>';
  }

  /** A row of cells. `seqFor(i, ch)` returns the glyph list for cell i. */
  row(size, x0, hy, pitch, text, seqName, delayFor, glyphsFor) {
    const { w } = SIZES[size];
    return [...text]
      .map((ch, i) => this.cell(size, x0 + i * pitch + w / 2, hy, glyphsFor(i, ch), seqName, delayFor(i)))
      .join('');
  }

  /**
   * Flip whole blocks (`ids[k]` = <defs> id shown in state k) around a hinge at y = 0.
   * `clipTop` / `clipBottom` are clipPath ids for the two halves.
   */
  block(ids, hy, seqName, delay, clipTop, clipBottom) {
    const n = ids.length;
    if (new Set(ids).size === 1) return `<use href="#${ids[0]}" y="${n2(hy)}"/>`;
    let s = `<g transform="translate(0,${n2(hy)})" style="--d:${delay}s">`;
    for (let k = 0; k < n; k++) {
      s += `<use href="#${ids[k]}" clip-path="url(#${clipTop})" class="${seqName}t${k}"/><use href="#${ids[k]}" clip-path="url(#${clipBottom})" class="${seqName}b${k}"/>`;
    }
    for (let k = 0; k < n; k++) {
      if (ids[k] !== ids[(k + 1) % n]) s += `<use href="#${ids[k]}" clip-path="url(#${clipTop})" class="${seqName}x${k}"/>`;
      if (ids[k] !== ids[(k - 1 + n) % n]) s += `<use href="#${ids[k]}" clip-path="url(#${clipBottom})" class="${seqName}y${k}"/>`;
    }
    return s + '</g>';
  }

  #seqCss(name, { starts, period: T, flip: d, rest, n }) {
    const p = (t) => `${+((t / T) * 100).toFixed(3)}%`;
    const fall = 'animation-timing-function:cubic-bezier(.55,0,.9,.4)';
    const land = 'animation-timing-function:cubic-bezier(.2,.7,.4,1)';
    const hold = 'animation-timing-function:step-end';
    let css = '';
    for (let k = 0; k < n; k++) {
      const a = starts[k];
      const last = k === n - 1;
      const b = last ? T : starts[k + 1];
      // Top half of state k is the "new" face from the moment the flip into k begins.
      const top =
        k === 0
          ? `0%{opacity:1}${p(b)}{opacity:0}100%{opacity:0}`
          : last
            ? `0%{opacity:0}${p(a)}{opacity:1}100%{opacity:1}`
            : `0%{opacity:0}${p(a)}{opacity:1}${p(b)}{opacity:0}100%{opacity:0}`;
      // Bottom half stays until the next state's bottom flap has landed on it.
      const bottom = last
        ? `0%{opacity:1}${p(d)}{opacity:0}${p(a + d)}{opacity:1}100%{opacity:1}`
        : `0%{opacity:0}${p(a + d)}{opacity:1}${p(b + d)}{opacity:0}100%{opacity:0}`;
      // Falling flap: top half of state k, when state k is being replaced.
      const fallKf = last
        ? `0%{transform:scaleY(1);${fall}}${p(d / 2)}{transform:scaleY(0);${hold}}100%{transform:scaleY(0)}`
        : `0%{transform:scaleY(0);${hold}}${p(b)}{transform:scaleY(1);${fall}}${p(b + d / 2)}{transform:scaleY(0);${hold}}100%{transform:scaleY(0)}`;
      // Landing flap: bottom half of state k, when state k arrives.
      const landKf = `0%{transform:scaleY(0)}${p(a + d / 2)}{transform:scaleY(0);${land}}${p(a + d)}{transform:scaleY(1);${hold}}${p(a + d + T * 0.0002)}{transform:scaleY(0)}100%{transform:scaleY(0)}`;

      const anim = (id, timing) => `animation:${id} ${T}s ${timing} var(--d,0s) infinite`;
      css += `@keyframes ${name}t${k}{${top}}@keyframes ${name}b${k}{${bottom}}@keyframes ${name}x${k}{${fallKf}}@keyframes ${name}y${k}{${landKf}}`;
      css += `.${name}t${k}{opacity:${k === rest ? 1 : 0};${anim(`${name}t${k}`, 'step-end')}}`;
      css += `.${name}b${k}{opacity:${k === rest ? 1 : 0};${anim(`${name}b${k}`, 'step-end')}}`;
      css += `.${name}x${k}{transform:scaleY(0);${anim(`${name}x${k}`, 'linear')}}`;
      css += `.${name}y${k}{transform:scaleY(0);${anim(`${name}y${k}`, 'linear')}}`;
    }
    return css;
  }

  css() {
    let css = '';
    const used = new Set([...this.glyphs.values()].map((g) => g.size));
    for (const size of used) {
      const { fs, fill } = SIZES[size];
      css += `.${size}g{font:700 ${fs}px ${FONT};fill:${fill};text-anchor:middle}`;
    }
    for (const [name, seq] of this.seqs) css += this.#seqCss(name, seq);
    css += this.extraCss.join('');
    css += '@media (prefers-reduced-motion:reduce){*{animation:none!important}}';
    return css;
  }

  defs() {
    let d = PLATE_GRADIENTS;
    const used = new Set([...this.glyphs.values()].map((g) => g.size));
    for (const size of used) {
      const { w, h, r } = SIZES[size];
      const x = w / 2;
      const y = h / 2;
      d += `<path id="${size}P" fill="url(#pT)" d="M${-x},${-GAP}V${-y + r}Q${-x},${-y} ${-x + r},${-y}H${x - r}Q${x},${-y} ${x},${-y + r}V${-GAP}Z"/>`;
      d += `<path id="${size}Q" fill="url(#pB)" d="M${-x},${GAP}V${y - r}Q${-x},${y} ${-x + r},${y}H${x - r}Q${x},${y} ${x},${y - r}V${GAP}Z"/>`;
      d += `<clipPath id="${size}c"><rect x="${-x}" y="${-y}" width="${w}" height="${y - GAP}"/></clipPath>`;
      d += `<clipPath id="${size}e"><rect x="${-x}" y="${GAP}" width="${w}" height="${y - GAP}"/></clipPath>`;
    }
    for (const [key, { size, ch }] of this.glyphs) {
      const code = key.split(':')[1];
      const yb = n2(SIZES[size].fs * 0.358); // puts the cap height on the hinge
      if (ch === ' ') {
        d += `<use id="${size}t${code}" href="#${size}P"/><use id="${size}b${code}" href="#${size}Q"/>`;
        continue;
      }
      const glyph = `<text class="${size}g" y="${yb}">${esc(ch)}</text>`;
      d += `<g id="${size}t${code}" clip-path="url(#${size}c)"><use href="#${size}P"/>${glyph}</g>`;
      d += `<g id="${size}b${code}" clip-path="url(#${size}e)"><use href="#${size}Q"/>${glyph}</g>`;
    }
    return d + this.extraDefs.join('');
  }
}

/** Glyph list for a cell that scrambles and settles on `ch` (state n-1 is the real one). */
function scrambleGlyphs(ch, n, rand) {
  if (ch === ' ') return Array(n).fill(' ');
  const out = [];
  for (let k = 0; k < n - 1; k++) {
    if (/\d/.test(ch)) out.push(String((+ch + 10 - (n - 1 - k)) % 10)); // digits count up
    else out.push(SCRAMBLE[Math.floor(rand() * SCRAMBLE.length)]);
  }
  out.push(ch);
  return out;
}

const housing = (W, H, rx = 16) =>
  `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${rx}" fill="${C.housing}" stroke="${C.edge}"/>` +
  `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${rx - 1}" fill="none" stroke="#fff" stroke-opacity=".035"/>`;

const svg = (W, H, title, kit, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">` +
  `<title>${esc(title)}</title><style>${BASE_CSS}${kit.css()}</style><defs>${kit.defs()}</defs>${body}</svg>\n`;

const BASE_CSS =
  `.lbl{font:600 10.5px ${MONO};letter-spacing:2.2px;fill:${C.mute}}` +
  `.end{text-anchor:end}.mid{text-anchor:middle}` +
  `@keyframes pulse{50%{opacity:.25}}` +
  `.pulse{animation:pulse 2.4s ease-in-out infinite}` +
  `.blink{animation:pulse 1.1s ease-in-out infinite}`;

const led = (cx, cy, color, cls = '') =>
  `<circle cx="${cx}" cy="${cy}" r="6.5" fill="${color}" opacity=".16"/><circle cx="${cx}" cy="${cy}" r="3.2" fill="${color}"${cls ? ` class="${cls}"` : ''}/>`;

/* ------------------------------------------------------------------ hero */

function buildHero(stats) {
  const W = 880;
  const H = 294;
  const kit = new Kit();
  const rand = rng(`hero:${cfg.name}`);
  const T = 16;
  const S = kit.seq('S', { starts: [0, 0.09, 0.18, 0.27], period: T, flip: 0.09, rest: 3 });
  const M = kit.seq('M', { starts: [0, 4, 8, 12], period: T, flip: 0.5, rest: 1 });

  let body = housing(W, H);

  // header rail
  body += led(34, 32, C.green, 'pulse');
  body += `<text class="lbl" x="50" y="36">GITHUB.COM/${esc(cfg.user.toUpperCase())}</text>`;
  body += `<text class="lbl end" x="${W - 28}" y="36">${esc(cfg.location)}</text>`;

  // name
  const name = cfg.name.toUpperCase();
  const L = SIZES.L;
  const pitchL = L.w + 6;
  const nameX = (W - (name.length * pitchL - 6)) / 2;
  body += kit.row('L', nameX, 56 + L.h / 2, pitchL, name, S,
    (i) => kit.delay(S, 0.3 + i * 0.07),
    (i, ch) => scrambleGlyphs(ch, 4, rand));

  // rotating line
  const COLS = 22;
  const lines = cfg.messages.map((m) => {
    const text = m.replace('{merged}', stats.merged).replace('{orgs}', stats.orgs).toUpperCase().slice(0, COLS);
    const left = Math.floor((COLS - text.length) / 2);
    return (' '.repeat(left) + text).padEnd(COLS, ' ');
  });
  const Mz = SIZES.M;
  const pitchM = Mz.w + 4;
  const lineX = (W - (COLS * pitchM - 4)) / 2;
  body += kit.row('M', lineX, 142 + Mz.h / 2, pitchM, ' '.repeat(COLS), M,
    (i) => kit.delay(M, 1.2 + i * 0.055),
    (i) => lines.map((line) => line[i]));

  // counters
  body += `<rect x="28" y="205.5" width="${W - 56}" height="1" fill="${C.edge}"/>`;
  const Sz = SIZES.S;
  const pitchS = Sz.w + 3;
  const blocks = [
    ['MERGED UPSTREAM', pad2(stats.merged)],
    ['ORGANISATIONS', pad2(stats.orgs)],
    ['IN REVIEW', pad2(stats.open)],
    ['LAST LANDED', stats.lastLanded ? boardDate(stats.lastLanded.date) : '-- ---'],
  ];
  blocks.forEach(([label, value], bi) => {
    const cx = (W * (2 * bi + 1)) / 8;
    const x0 = cx - (value.length * pitchS - 3) / 2;
    body += kit.row('S', x0, 220 + Sz.h / 2, pitchS, value, S,
      (i) => kit.delay(S, 2.0 + bi * 0.3 + i * 0.07),
      (i, ch) => scrambleGlyphs(ch, 4, rand));
    body += `<text class="lbl mid" x="${cx}" y="274">${label}</text>`;
  });

  const title = `${cfg.name} — ${cfg.messages[0]}. ${stats.merged} pull requests merged upstream across ${stats.orgs} open-source organisations, ${stats.open} in review.`;
  return { svg: svg(W, H, title, kit, body), title };
}

/* -------------------------------------------------------------- arrivals */

const STATUS = {
  merged: { text: 'LANDED', cls: 'g', led: C.green, anim: '' },
  approved: { text: 'APPROVED', cls: 'g', led: C.green, anim: 'blink' },
  open: { text: 'IN REVIEW', cls: 'a', led: C.amber, anim: 'pulse' },
  draft: { text: 'DRAFT', cls: 'm', led: C.mute, anim: '' },
};

function buildArrivals(prs, stats) {
  const W = 880;
  const PITCH = 20;
  const X0 = 20;
  const ROWS = 7;
  const MAX_PAGES = 4;
  const ROW_H = 28;
  const ROW_PITCH = 34;
  const TOP = 86;
  const H = TOP + ROWS * ROW_PITCH - (ROW_PITCH - ROW_H) + 42;
  // column blocks on one shared 20px grid: [first column, width]
  const COL = { date: [0, 6], repo: [7, 18], pr: [26, 6], status: [33, 9] };
  const LED_COL = 32;
  const colX = (c) => X0 + c * PITCH;

  const kit = new Kit();
  const shown = prs.slice(0, ROWS * MAX_PAGES);
  const pages = [];
  for (let i = 0; i < shown.length; i += ROWS) pages.push(shown.slice(i, i + ROWS));
  if (pages.length === 0) pages.push([]);
  const n = pages.length;
  const DWELL = 6;
  const P = kit.seq('P', { starts: pages.map((_, k) => k * DWELL), period: n * DWELL, flip: 0.46, rest: 0 });

  const half = ROW_H / 2;
  const SLIT = 0.45; // half of the slit on the small row flaps
  kit.extraDefs.push(
    `<pattern id="grid" x="${X0}" y="${-half}" width="${PITCH}" height="${ROW_H}" patternUnits="userSpaceOnUse">` +
      `<path fill="url(#pT)" d="M1,${half - SLIT}V2.5Q1,0 3.5,0H${PITCH - 3.5}Q${PITCH - 1},0 ${PITCH - 1},2.5V${half - SLIT}Z"/>` +
      `<path fill="url(#pB)" d="M1,${half + SLIT}V${ROW_H - 2.5}Q1,${ROW_H} 3.5,${ROW_H}H${PITCH - 3.5}Q${PITCH - 1},${ROW_H} ${PITCH - 1},${ROW_H - 2.5}V${half + SLIT}Z"/>` +
      `</pattern>` +
      `<clipPath id="rc"><rect x="0" y="${-half}" width="${W}" height="${half - SLIT}"/></clipPath>` +
      `<clipPath id="re"><rect x="0" y="${SLIT}" width="${W}" height="${half - SLIT}"/></clipPath>`,
  );
  kit.extraCss.push(
    `.c{font:700 16px ${FONT};text-anchor:middle;fill:${C.ink}}.s{fill:${C.soft}}.g{fill:${C.green}}.a{fill:${C.amber}}.m{fill:${C.mute}}` +
      `.ttl{font:700 21px ${FONT};letter-spacing:7px;fill:${C.ink}}`,
  );

  const plate = ([c0, width]) =>
    `<rect x="${colX(c0)}" y="${-half}" width="${width * PITCH}" height="${ROW_H}" fill="url(#grid)"/>`;
  // One <text> per field; each character gets its own x, so it is centred in its own flap.
  const field = ([c0, width], str, cls) => {
    const xs = [];
    let chars = '';
    [...str.slice(0, width)].forEach((ch, i) => {
      if (ch === ' ') return;
      xs.push(colX(c0 + i) + PITCH / 2);
      chars += ch;
    });
    return chars ? `<text class="c ${cls}" y="5.8" x="${xs.join(' ')}">${esc(chars)}</text>` : '';
  };

  const blockNames = Object.keys(COL);
  for (const b of blockNames) kit.extraDefs.push(`<g id="x_${b}">${plate(COL[b])}</g>`);
  pages.forEach((page, k) => {
    page.forEach((pr, i) => {
      const st = STATUS[pr.state];
      const text = {
        date: [boardDate(pr.date), 's'],
        repo: [repoInfo(pr.repo).board, ''],
        pr: [`#${pr.number}`, 's'],
        status: [st.text, st.cls],
      };
      for (const b of blockNames) {
        kit.extraDefs.push(`<g id="r${k}_${i}_${b}">${plate(COL[b])}${field(COL[b], ...text[b])}</g>`);
      }
    });
  });

  let body = housing(W, H);

  // header
  body += `<path d="M24,27 l9,9 v-6.2 M33,36 h-6.2" fill="none" stroke="${C.amber}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  body += `<text class="ttl" x="46" y="39">ARRIVALS</text>`;
  body += `<text class="lbl" x="236" y="37">PULL REQUESTS · UPSTREAM REPOSITORIES</text>`;
  const dotsX = W - 26 - n * 14;
  for (let k = 0; k < n; k++) {
    body += `<rect x="${dotsX + k * 14}" y="28" width="9" height="9" rx="2" fill="${C.dim}"/>`;
    if (n > 1) body += `<rect x="${dotsX + k * 14}" y="28" width="9" height="9" rx="2" fill="${C.amber}" class="${P}t${k}" style="--d:${kit.delay(P, 0.7)}s"/>`;
  }
  body += `<rect x="20" y="52.5" width="${W - 40}" height="1" fill="${C.edge}"/>`;
  body += `<text class="lbl" x="${colX(COL.date[0]) + 2}" y="72">DATE</text>`;
  body += `<text class="lbl" x="${colX(COL.repo[0]) + 2}" y="72">REPOSITORY</text>`;
  body += `<text class="lbl" x="${colX(COL.pr[0]) + 2}" y="72">PULL REQUEST</text>`;
  body += `<text class="lbl" x="${colX(COL.status[0]) + 2}" y="72">STATUS</text>`;

  // rows
  for (let i = 0; i < ROWS; i++) {
    const hy = TOP + i * ROW_PITCH + half;
    blockNames.forEach((b, j) => {
      const ids = pages.map((page, k) => (page[i] ? `r${k}_${i}_${b}` : `x_${b}`));
      body += kit.block(ids, hy, P, kit.delay(P, 0.7 + i * 0.13 + j * 0.06), 'rc', 're');
    });
    pages.forEach((page, k) => {
      if (!page[i]) return;
      const st = STATUS[page[i].state];
      const lamp = led(colX(LED_COL) + PITCH / 2, hy, st.led, st.anim);
      body += n > 1 ? `<g class="${P}t${k}" style="--d:${kit.delay(P, 0.7 + i * 0.13 + 0.4)}s">${lamp}</g>` : lamp;
    });
  }

  // footer
  const fy = H - 18;
  body += led(30, fy - 4, C.green);
  body += `<text class="lbl" x="44" y="${fy}">${stats.merged} LANDED = MERGED</text>`;
  body += led(248, fy - 4, C.amber);
  body += `<text class="lbl" x="262" y="${fy}">${stats.open} IN REVIEW = OPEN</text>`;
  body += `<text class="lbl end" x="${W - 26}" y="${fy}">REBUILT DAILY FROM THE GITHUB API</text>`;

  const title = `Arrivals board: ${stats.merged} pull requests merged into upstream repositories, ${stats.open} in review.`;
  return { svg: svg(W, H, title, kit, body), title };
}

/* ---------------------------------------------------------------- ticker */

function buildTicker(prs, stats) {
  const W = 880;
  const H = 38;
  const kit = new Kit();
  const CHAR = 11.4;
  const SPEED = 46; // px per second

  const merged = prs.filter((p) => p.state === 'merged');
  const names = [...new Set(merged.map((p) => repoInfo(p.repo).board))];
  const parts = [];
  if (stats.lastLanded) {
    const l = stats.lastLanded;
    parts.push(`LAST LANDED ${repoInfo(l.repo).board} #${l.number} ${boardDate(l.date)}`);
  }
  parts.push(`${stats.merged} MERGED UPSTREAM`, `${stats.open} IN REVIEW`, names.join(' · '));
  const text = parts.map((p) => `${p} ///`).join(' ');
  const len = [...text].length * CHAR;
  const loop = len + CHAR;

  kit.extraCss.push(
    `.tk{font:700 18px ${MONO};fill:${C.amber}}` +
      `@keyframes roll{to{transform:translateX(${n2(-loop)}px)}}` +
      `.roll{animation:roll ${n2(loop / SPEED)}s linear infinite}`,
  );
  kit.extraDefs.push(
    `<pattern id="px" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0,2.5H3M2.5,0V3" stroke="${C.housing}" stroke-width=".9" stroke-opacity=".5"/></pattern>` +
      `<linearGradient id="fl" x1="0" x2="1"><stop offset="0" stop-color="${C.housing}"/><stop offset="1" stop-color="${C.housing}" stop-opacity="0"/></linearGradient>` +
      `<linearGradient id="fr" x1="1" x2="0"><stop offset="0" stop-color="${C.housing}"/><stop offset="1" stop-color="${C.housing}" stop-opacity="0"/></linearGradient>` +
      `<clipPath id="win"><rect x="6" y="4" width="${W - 12}" height="${H - 8}" rx="6"/></clipPath>`,
  );

  const run = (x) => `<text class="tk" x="${n2(x)}" y="25" textLength="${n2(len)}" lengthAdjust="spacing">${esc(text)}</text>`;
  let body = housing(W, H, 10);
  body += `<g clip-path="url(#win)"><g class="roll">${run(20)}${run(20 + loop)}${run(20 + 2 * loop)}</g>`;
  body += `<rect x="0" y="0" width="${W}" height="${H}" fill="url(#px)"/>`;
  body += `<rect x="6" y="4" width="70" height="${H - 8}" fill="url(#fl)"/><rect x="${W - 76}" y="4" width="70" height="${H - 8}" fill="url(#fr)"/></g>`;

  return { svg: svg(W, H, text.replace(/ \/\/\//g, '.'), kit, body) };
}

/* ----------------------------------------------------------------- links */

function buildLink(label, index) {
  const kit = new Kit();
  const rand = rng(`link:${label}`);
  const S = kit.seq('S', { starts: [0, 0.09, 0.18, 0.27], period: 16, flip: 0.09, rest: 3 });
  const Sz = SIZES.S;
  const pitch = Sz.w + 3;
  const H = 44;
  const x0 = 32;
  const W = x0 + label.length * pitch - 3 + 40;
  let body = housing(W, H, 11);
  body += led(17, H / 2, C.green, 'pulse');
  body += kit.row('S', x0, H / 2, pitch, label, S,
    (i) => kit.delay(S, 3.2 + index * 0.45 + i * 0.07),
    (i, ch) => scrambleGlyphs(ch, 4, rand));
  const ax = W - 28;
  body += `<path d="M${ax},${H / 2 + 6} l11,-11 M${ax + 3},${H / 2 - 5} h8 v8" fill="none" stroke="${C.amber}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
  return svg(W, H, label, kit, body);
}

/** One half of the Board / Classic switch. `on` marks the version being shown. */
function buildSwitch(label, on) {
  const kit = new Kit();
  const size = on ? 'S' : 'D';
  const pitch = SIZES[size].w + 3;
  const H = 44;
  const x0 = 32;
  const W = x0 + label.length * pitch - 3 + 14;
  let body = housing(W, H, 11);
  if (on) body += `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="11" fill="none" stroke="${C.amber}" stroke-opacity=".55"/>`;
  body += on ? led(17, H / 2, C.amber, 'pulse') : `<circle cx="17" cy="${H / 2}" r="3.2" fill="${C.dim}"/>`;
  body += kit.row(size, x0, H / 2, pitch, label, null, () => 0, (i, ch) => [ch]);
  return svg(W, H, `${label} view${on ? ', showing now' : ''}`, kit, body);
}

/* ---------------------------------------------------------------- readme */

const mdEscape = (s) => s.replace(/([\\`*_\[\]<>])/g, '\\$1');

function prListMarkdown(prs, stats) {
  const merged = prs.filter((p) => p.state === 'merged');
  const open = prs.filter((p) => p.state !== 'merged');
  const byRepo = new Map();
  for (const pr of merged) byRepo.set(pr.repo, [...(byRepo.get(pr.repo) ?? []), pr]);
  const groups = [...byRepo.entries()].sort((a, b) => b[1].length - a[1].length || b[1][0].date.localeCompare(a[1][0].date));

  let md = `<details>\n<summary><b>All ${stats.merged} merged pull requests</b>, with links${open.length ? ` · ${open.length} more in review` : ''}</summary>\n<br>\n\n`;
  for (const [repo, list] of groups) {
    md += `**${repoInfo(repo).heading}** — ${list.length} merged\n\n`;
    for (const pr of list) md += `- [#${pr.number}](${pr.url}) ${mdEscape(pr.title)} · <sub>${proseDate(pr.date)}</sub>\n`;
    md += '\n';
  }
  if (open.length) {
    md += `**In review**\n\n`;
    for (const pr of open) {
      const tag = pr.state === 'approved' ? ' · <sub>approved</sub>' : pr.state === 'draft' ? ' · <sub>draft</sub>' : '';
      md += `- [${pr.repo} #${pr.number}](${pr.url}) ${mdEscape(pr.title)}${tag}\n`;
    }
    md += '\n';
  }
  return md + '</details>';
}

function proseList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function replaceBlock(md, name, body) {
  const re = new RegExp(`(<!-- board:${name}:start -->)[\\s\\S]*?(<!-- board:${name}:end -->)`);
  if (!re.test(md)) throw new Error(`README.md is missing the board:${name} markers`);
  return md.replace(re, (_, a, b) => `${a}\n${body}\n${b}`);
}

/* ------------------------------------------------------------------ main */

async function writeIfChanged(path, content) {
  let old = null;
  try {
    old = await readFile(path, 'utf8');
  } catch {}
  if (old === content) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return true;
}

let prs;
if (OFFLINE) {
  prs = JSON.parse(await readFile(DATA, 'utf8')).prs;
} else {
  try {
    prs = await fetchPRs();
  } catch (err) {
    // Rate limit or network trouble: keep yesterday's data rather than fail the daily run.
    console.warn(`::warning::GitHub API unavailable, using cached data: ${err.message}`);
    try {
      prs = JSON.parse(await readFile(DATA, 'utf8')).prs;
    } catch {
      process.exit(0);
    }
  }
}
const merged = prs.filter((p) => p.state === 'merged');
const stats = {
  merged: merged.length,
  open: prs.length - merged.length,
  orgs: new Set(merged.map((p) => p.repo.split('/')[0].toLowerCase())).size,
  lastLanded: merged[0] ?? null,
};

let contrib = null;
if (!OFFLINE) {
  try {
    contrib = await fetchContrib();
  } catch (err) {
    console.warn(`::warning::Contribution calendar not refreshed, using cached data: ${err.message}`);
  }
}
if (!contrib) {
  try {
    contrib = JSON.parse(await readFile(CONTRIB, 'utf8'));
    contrib.days = contrib.days.map(([date, count, level]) => ({ date, count, level }));
  } catch {}
}

const DAYLOG = join(ROOT, 'data', 'daylog.json');
let dayLog = null;
if (!OFFLINE) {
  try {
    dayLog = await fetchDayLog();
  } catch (err) {
    console.warn(`::warning::Day-by-day log not refreshed, using cached data: ${err.message}`);
  }
}
if (!dayLog) {
  try {
    dayLog = JSON.parse(await readFile(DAYLOG, 'utf8'));
  } catch {
    dayLog = {};
  }
}

const hero = buildHero(stats);
const arrivals = buildArrivals(prs, stats);
const ticker = buildTicker(prs, stats);

// Repositories in the order the summary sentence names them: most merged first.
const counts = new Map();
for (const pr of merged) counts.set(pr.repo, (counts.get(pr.repo) ?? 0) + 1);
const order = Object.keys(cfg.repos ?? {});
const named = [...counts.keys()]
  .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
  .map((repo) => repoInfo(repo).prose);

// Which version is the profile: the stored choice, or --use <version> to change it.
const VERSIONS = { motion: 'MOTION.md', board: 'BOARD.md', classic: 'CLASSIC.md' };
let active = VERSIONS[cfg.active] ? cfg.active : 'board';
const useAt = process.argv.indexOf('--use');
if (useAt !== -1) {
  active = process.argv[useAt + 1];
  if (!VERSIONS[active]) {
    console.error(`--use expects one of: ${Object.keys(VERSIONS).join(', ')}`);
    process.exit(1);
  }
}

/** The switch shown at the top of `version`. The active version lives at the profile URL. */
function switchBlock(version) {
  const home = `https://github.com/${cfg.user}`;
  const url = (v) => (v === active ? home : `${home}/${cfg.user}/blob/main/${VERSIONS[v]}`);
  const half = (v, label) =>
    `<a href="${url(v)}"><img src="assets/switch-${v}-${v === version ? 'on' : 'off'}.svg" height="30" alt="${label} view${v === version ? ' (showing now)' : ''}"></a>`;
  return `<p align="right">${half('motion', 'Motion')} ${half('board', 'Board')} ${half('classic', 'Classic')}</p>`;
}

const summaryLine = `**${stats.merged} pull requests merged upstream** in ${proseList(named)}.`;
const image = (file, alt) => `<p align="center"><img src="assets/${file}" width="100%" alt="${esc(alt)}"></p>`;

// MOTION.md
const motion = createMotion({ cfg, esc, n2, rng, repoInfo, boardDate });
const mHero = motion.hero(stats);
const mOrgs = motion.orgs(prs);
const mLog = motion.log(prs, stats);
const mContrib = contrib ? motion.contrib(contrib) : null;
let motionMd = await readFile(join(ROOT, VERSIONS.motion), 'utf8');
motionMd = replaceBlock(motionMd, 'switch', switchBlock('motion'));
motionMd = replaceBlock(motionMd, 'hero', image('m-hero.svg', mHero.title));
motionMd = replaceBlock(motionMd, 'summary', summaryLine);
motionMd = replaceBlock(motionMd, 'log', `${image('m-log.svg', `${mLog.title} The full list is below.`)}\n\n${prListMarkdown(prs, stats)}`);
if (mContrib) {
  const dayByDay = dayLogMarkdown(contrib.days, dayLog);
  motionMd = replaceBlock(motionMd, 'contrib', `${image('m-contrib.svg', mContrib.title)}${dayByDay ? `\n\n${dayByDay}` : ''}`);
}

// BOARD.md
let readme = await readFile(join(ROOT, VERSIONS.board), 'utf8');
readme = replaceBlock(readme, 'switch', switchBlock('board'));
readme = replaceBlock(readme, 'hero', `<p align="center"><img src="assets/hero.svg" width="100%" alt="${esc(hero.title)}"></p>`);
readme = replaceBlock(readme, 'summary', summaryLine);
readme = replaceBlock(
  readme,
  'arrivals',
  `<p align="center"><img src="assets/arrivals.svg" width="100%" alt="${esc(arrivals.title)} The full list is below."></p>\n\n${prListMarkdown(prs, stats)}`,
);

const classic = replaceBlock(await readFile(join(ROOT, VERSIONS.classic), 'utf8'), 'switch', switchBlock('classic'));
const configText = await readFile(join(ROOT, 'board.config.json'), 'utf8');

/**
 * README.md holds all three looks as one switch. A profile README runs no script or style, but GitHub keeps
 * the `name` attribute of <details>, and browsers open only one <details> of a name group at a time: opening
 * BOARD closes MOTION in place. The active look is last and open, so the two closed ones sit at the top.
 * The summaries are text, not the switch images: GitHub wraps an image in a link to the image file, and a
 * click on it would open that file instead of the section.
 */
function profileSwitch(contents) {
  const label = { motion: 'MOTION', board: 'BOARD', classic: 'CLASSIC' };
  const order = [...Object.keys(VERSIONS).filter((v) => v !== active), active];
  const looks = order.map(
    (v) =>
      `<details name="look"${v === active ? ' open' : ''}>\n<summary><kbd>${label[v]}</kbd> view</summary>\n<br>\n\n` +
      `${replaceBlock(contents[v], 'switch', '').replace(/<!-- board:switch:start -->\s*<!-- board:switch:end -->\s*/, '').trim()}\n\n</details>`,
  );
  return `<p align="right">Three looks of this profile: open one and the others close.</p>\n\n${looks.join('\n\n')}\n`;
}
const contents = { motion: motionMd, board: readme, classic };
const profileReadme = profileSwitch(contents);

const files = [
  [DATA, JSON.stringify({ prs }, null, 2) + '\n'],
  [join(ROOT, 'assets', 'hero.svg'), hero.svg],
  [join(ROOT, 'assets', 'arrivals.svg'), arrivals.svg],
  [join(ROOT, 'assets', 'ticker.svg'), ticker.svg],
  ...cfg.links.map((l, i) => [join(ROOT, 'assets', `link-${l.id}.svg`), buildLink(l.label, i)]),
  [join(ROOT, 'assets', 'm-hero.svg'), mHero.svg],
  [join(ROOT, 'assets', 'm-orgs.svg'), mOrgs.svg],
  [join(ROOT, 'assets', 'm-log.svg'), mLog.svg],
  ...(mContrib
    ? [
        [join(ROOT, 'assets', 'm-contrib.svg'), mContrib.svg],
        [CONTRIB, contribJson(contrib)],
      ]
    : []),
  ...cfg.links.map((l, i) => [join(ROOT, 'assets', `m-link-${l.id}.svg`), motion.link(l.label, i)]),
  ...Object.keys(VERSIONS).flatMap((v) => [
    [join(ROOT, 'assets', `switch-${v}-on.svg`), buildSwitch(v.toUpperCase(), true)],
    [join(ROOT, 'assets', `switch-${v}-off.svg`), buildSwitch(v.toUpperCase(), false)],
  ]),
  [join(ROOT, VERSIONS.motion), motionMd],
  [join(ROOT, VERSIONS.board), readme],
  [join(ROOT, VERSIONS.classic), classic],
  [DAYLOG, dayLogJson(dayLog)],
  [join(ROOT, 'README.md'), profileReadme],
  [join(ROOT, 'board.config.json'), configText.replace(/"active":\s*"[^"]*"/,`"active": "${active}"`)],
];
let changed = 0;
for (const [path, content] of files) if (await writeIfChanged(path, content)) changed++;
console.log(`${stats.merged} merged · ${stats.open} in review · ${stats.orgs} orgs · profile: ${active} — ${changed} file(s) updated`);
