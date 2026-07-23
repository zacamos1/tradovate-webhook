#!/usr/bin/env node
/* dashboard.js — Premium Selling Engine Readiness Dashboard (v1).
 *
 * Pure rendering layer: reads the jsonl logs, writes dashboards/YYYY-MM-DD.md
 * and prints it. Touches no trading code. Metrics with N<30 render but are
 * marked (n=X — not yet meaningful) per the small-sample discipline.
 *
 * Sources: pmtracker_multi_log.jsonl (settles), credit_verification.jsonl
 * (honesty ratios), fly_ledger.jsonl (fills/lifecycle), fly_marks.jsonl
 * (intraday paths), mfe.jsonl (directional book).
 *
 * Run manually:  node dashboard.js
 * Cron (after settler, 16:45 ET):
 *   45 20 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node dashboard.js >> dashboard.out 2>&1
 */
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const LIVE = { variant: 'vol_wide', symbols: ['XSP', 'IWM'] };
const jl = (f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const today = new Date().toISOString().slice(0, 10);
const pct = (x) => (x == null ? '—' : (x * 100).toFixed(0) + '%');
const usd = (x) => (x == null ? '—' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const gray = (n, min = 30) => (n >= min ? '' : `  *(n=${n} — not yet meaningful)*`);

const settles = jl('pmtracker_multi_log.jsonl').filter((r) => r.real_pl != null && r.intended_fly);
const ratios = jl('credit_verification.jsonl').filter((r) => r.ratio != null);
const ledger = jl('fly_ledger.jsonl');
const marks = jl('fly_marks.jsonl');
const mfe = jl('mfe.jsonl');

let out = [];
const P = (s = '') => out.push(s);

P(`# Readiness Dashboard — ${today}`);
P();

/* ---------- 1. honesty ratio (the number) ---------- */
P(`## Fill honesty (model vs market)`);
const rToday = ratios.filter((r) => r.date === today);
const rAll = ratios;
if (rAll.length) {
  const avg = (a) => a.reduce((s, r) => s + r.ratio, 0) / a.length;
  P(`- today: ${rToday.length ? rToday.map((r) => `${r.symbol}/${r.variant} ${r.ratio.toFixed(3)}`).join(', ') : '—'}`);
  P(`- trailing avg ratio: **${avg(rAll).toFixed(3)}** over ${rAll.length} readings${gray(rAll.length, 10)}`);
} else P(`- no verification readings yet (first prints at 9:44 ET on a trading day)`);
P();

/* ---------- 2. real fills (from ledger) ---------- */
P(`## Real fills`);
const fills = ledger.filter((e) => e.event === 'filled');
const unresolved = Object.entries(ledger.reduce((m, e) => ((m[e.flyId] = e.event), m), {})).filter(([, ev]) => ev === 'orphan_unresolved');
P(`- fills to date: **${fills.length}** (go-live gate: 5–10)${fills.length ? ' — ' + fills.slice(-3).map((f) => f.flyId.split('_').slice(1).join('_')).join(', ') : ''}`);
P(`- unresolved orphans: ${unresolved.length ? '**' + unresolved.length + ' — ATTENTION**' : '0 ✅'}`);
P();

/* ---------- 3. live-book performance ---------- */
P(`## Live book (${LIVE.variant}: ${LIVE.symbols.join(' + ')}) — model credits`);
const lb = settles.filter((r) => r.variant === LIVE.variant && LIVE.symbols.includes(r.symbol));
const days = [...new Set(lb.map((r) => r.date))].sort();
const dayPl = days.map((d) => lb.filter((r) => r.date === d).reduce((s, r) => s + r.real_pl, 0));
const cum = dayPl.reduce((s, x) => s + x, 0);
P(`- days tracked: ${days.length} | cumulative: **${usd(cum)}** | avg/day: ${usd(cum / (days.length || 1))}${gray(days.length)}`);
const greenDays = dayPl.filter((x) => x > 0).length;
P(`- green days: ${greenDays}/${days.length} | worst day: ${usd(Math.min(...dayPl))} | best: ${usd(Math.max(...dayPl, 0))}`);
// per-symbol capture + wing usage
for (const sym of LIVE.symbols) {
  const rows = lb.filter((r) => r.symbol === sym);
  if (!rows.length) { P(`- ${sym}: no settled rows yet`); continue; }
  const capt = rows.map((r) => r.real_pl / (r.intended_fly.model_credit * (r.contracts || 1)));
  const usage = rows.map((r) => {
    const keptPc = r.real_pl / (r.contracts || 1) / 100;           // $/share kept
    const move = Math.max(0, r.intended_fly.model_credit / 100 - keptPc);
    return Math.min(1, move / r.intended_fly.wing_pts);
  });
  const mx = Math.max(...usage);
  P(`- ${sym}: avg credit captured ${pct(capt.reduce((a, b) => a + b) / capt.length)} | max wing usage ${pct(mx)}${mx > 0.7 ? ' ⚠️' : ''} | max-loss days ${rows.filter((r) => r.was_max_loss).length}`);
}
P();

/* ---------- 4. variant race ---------- */
P(`## Variant race (per $ risked, settled rows)`);
const variants = [...new Set(settles.map((r) => r.variant || 'base'))];
const race = variants.map((v) => {
  const rows = settles.filter((r) => (r.variant || 'base') === v && ['XSP', 'IWM', 'SPY'].includes(r.symbol));
  const pl = rows.reduce((s, r) => s + r.real_pl, 0);
  const risk = rows.reduce((s, r) => s + ((r.intended_fly.max_loss ?? r.intended_fly.maxloss ?? (r.intended_fly.wing_pts * 100 - r.intended_fly.model_credit)) || 0) * (r.contracts || 1), 0);
  return { v, n: rows.length, pl, eff: risk > 0 ? pl / risk : null };   // guard: schema gaps/negative denominators render as '—', never as garbage
}).filter((x) => x.n).sort((a, b) => (b.eff ?? -9) - (a.eff ?? -9));
for (const x of race) P(`- ${x.v}: ${usd(x.pl)} over ${x.n} rows | per-$ ${x.eff != null ? x.eff.toFixed(3) : '—'}${gray(x.n)}`);
P();

/* ---------- 5. intraday path (today) ---------- */
const mToday = marks.filter((m) => m.date === today && m.quotes_ok);
if (mToday.length) {
  P(`## Intraday path (real marks, today)`);
  for (const sym of LIVE.symbols) {
    const ms = mToday.filter((m) => m.symbol === sym && m.variant === LIVE.variant);
    if (ms.length) P(`- ${sym}: ${ms.length} marks | peak ${Math.max(...ms.map((m) => m.pl_pct_of_credit)).toFixed(0)}% | last ${ms[ms.length - 1].pl_pct_of_credit.toFixed(0)}% of credit`);
  }
  P();
}

/* ---------- 6. directional book (decision-grade) ---------- */
P(`## Directional book *(decision-grade marks — see rebuild spec)*`);
const dToday = mfe.filter((r) => (r.ts || '').startsWith(today));
const dPl = dToday.reduce((s, t) => s + (t.exitPriceApprox - t.entryPrice) * 100 * (t.qty || 1), 0);
P(`- today: ${dToday.length} exits, ${usd(dPl)} | reasons: ${JSON.stringify(dToday.reduce((a, t) => ((a[t.reason] = (a[t.reason] || 0) + 1), a), {}))}`);
P();

/* ---------- 7. promotion checklist (auto-evaluated) ---------- */
P(`## Promotion checklist (go-live gates)`);
const checks = [
  [days.length >= 30, `30+ tracked days on live-book config (${days.length}/30)`],
  [fills.length >= 5, `5+ real fills for ratio sample (${fills.length}/5)`],
  [rAll.length >= 5, `5+ honesty-ratio readings (${rAll.length}/5)`],
  [rAll.length >= 5 && rAll.reduce((s, r) => s + r.ratio, 0) / (rAll.length || 1) >= 0.75, `trailing honesty ratio ≥ 0.75`],
  [unresolved.length === 0, `zero unresolved orphans`],
  [false, `kill-criteria document written (manual check)`],
  [false, `live second-username architecture set up (manual check)`],
];
for (const [ok, label] of checks) P(`- ${ok ? '✅' : '⬜'} ${label}`);
P();
P(`---`);
P(`*Sharpe/Kelly deliberately omitted until N≥30. All fly P&L is model-credit until the fill sample matures.*`);

const report = out.join('\n');
const dir = path.join(DIR, 'dashboards');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, `${today}.md`), report);
console.log(report);
console.log(`\n[saved dashboards/${today}.md]`);
