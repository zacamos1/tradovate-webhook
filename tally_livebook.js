#!/usr/bin/env node
/* tally_livebook.js — running P&L + capital-tied-up for the prospective live book.
 *
 * Premium side: pmtracker_multi_log.jsonl, variant='vol', symbols SPY/XSP/IWM only
 *               (QQQ and SPX excluded by design).
 * Directional:  mfe.jsonl exit-logger rows; $P&L = (exit-entry)*100*qty,
 *               concurrency rebuilt from ts minus minsHeld.
 *
 * Run from ~/ibkr-webhook:  node tally_livebook.js
 */
const fs = require('fs');

const LIVE_SYMS = ['SPY', 'XSP', 'IWM'];
const SIZES = [6000, 12000];
const f2 = (x) => (x == null ? '-' : (+x).toFixed(2));
const pct = (x, base) => ((x / base) * 100).toFixed(1) + '%';

function readJsonl(path) {
  if (!fs.existsSync(path)) { console.error(`(missing: ${path})`); return []; }
  return fs.readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch (e) { console.error(`(bad json line ${i + 1} in ${path})`); return null; }
  }).filter(Boolean);
}

/* ============================= PREMIUM ==================================== */
const pm = readJsonl('pmtracker_multi_log.jsonl');
const live = pm.filter(r => r.variant === 'vol' && LIVE_SYMS.includes(r.symbol));
const settled = live.filter(r => r.real_pl != null);
const skippedGate = live.filter(r => r.TRADE !== true);

console.log('='.repeat(78));
console.log('PREMIUM LIVE BOOK — vol variant, SPY + XSP + IWM (QQQ/SPX excluded)');
console.log('='.repeat(78));

const bySym = {};
for (const r of settled) {
  const s = bySym[r.symbol] = bySym[r.symbol] || { n: 0, w: 0, ml: 0, pl: 0, risk: 0, worst: 0, best: 0 };
  s.n++; s.pl += r.real_pl;
  if (r.real_pl > 0) s.w++;
  if (r.was_max_loss) s.ml++;
  s.risk += r.capital_at_risk || 0;
  s.worst = Math.min(s.worst, r.real_pl);
  s.best = Math.max(s.best, r.real_pl);
}
console.log('sym\tdays\twins\tmaxloss\ttotal P&L\tavg/day\tworst\tbest');
let pmTotal = 0;
for (const sym of LIVE_SYMS) {
  const s = bySym[sym];
  if (!s) { console.log(`${sym}\t0\t(no settled vol rows — ${sym === 'IWM' ? 'RVX was broken; proxy starts tomorrow' : 'none logged'})`); continue; }
  pmTotal += s.pl;
  console.log(`${sym}\t${s.n}\t${s.w}\t${s.ml}\t$${f2(s.pl)}\t$${f2(s.pl / s.n)}\t$${f2(s.worst)}\t$${f2(s.best)}`);
}
console.log('-'.repeat(78));
console.log(`TOTAL live-book premium P&L: $${f2(pmTotal)}   (settled rows: ${settled.length}, gate-skipped: ${skippedGate.length})`);

// daily capital at risk (sum across the book per date, TRADE rows only)
const daily = {};
for (const r of live.filter(r => r.TRADE === true)) {
  daily[r.date] = (daily[r.date] || 0) + (r.capital_at_risk || 0);
}
const dvals = Object.values(daily);
if (dvals.length) {
  const peak = Math.max(...dvals), avg = dvals.reduce((a, b) => a + b, 0) / dvals.length;
  const peakDay = Object.keys(daily).find(d => daily[d] === peak);
  console.log(`\nCapital at risk (book/day): avg $${f2(avg)}   peak $${f2(peak)} on ${peakDay}   days: ${dvals.length}`);
  for (const acct of SIZES) {
    console.log(`  vs $${acct}: avg ${pct(avg, acct)} of account, peak ${pct(peak, acct)}; 3x simultaneous max-loss ≈ ${pct(peak, acct)} (defined risk = capital_at_risk)`);
  }
}

/* ============================ DIRECTIONAL ================================= */
const mfe = readJsonl('mfe.jsonl');
console.log('\n' + '='.repeat(78));
console.log(`DIRECTIONAL — mfe.jsonl exit-logger (${mfe.length} exits)`);
console.log('='.repeat(78));

const dBySym = {}, byReason = {};
const intervals = [];
let dTotal = 0, dWins = 0, winSum = 0, lossSum = 0;
for (const t of mfe) {
  if (t.entryPrice == null || t.exitPriceApprox == null) continue;
  const qty = t.qty || 1;
  const pl = (t.exitPriceApprox - t.entryPrice) * 100 * qty;
  const outlay = t.entryPrice * 100 * qty;
  dTotal += pl;
  if (pl > 0) { dWins++; winSum += pl; } else { lossSum += pl; }
  const s = dBySym[t.symbol] = dBySym[t.symbol] || { n: 0, w: 0, pl: 0, outlay: 0 };
  s.n++; s.pl += pl; s.outlay += outlay; if (pl > 0) s.w++;
  const r = byReason[t.reason || '?'] = byReason[t.reason || '?'] || { n: 0, pl: 0 };
  r.n++; r.pl += pl;
  const end = new Date(t.ts).getTime();
  const start = end - (t.minsHeld || 0) * 60000;
  intervals.push({ start, end, outlay, day: (t.ts || '').slice(0, 10) });
}

console.log('sym\ttrades\twins\twin%\ttotal P&L\tavg outlay');
for (const sym of Object.keys(dBySym).sort()) {
  const s = dBySym[sym];
  console.log(`${sym}\t${s.n}\t${s.w}\t${(s.w / s.n * 100).toFixed(0)}%\t$${f2(s.pl)}\t$${f2(s.outlay / s.n)}`);
}
console.log('-'.repeat(78));
const dN = mfe.length ? Object.values(dBySym).reduce((a, s) => a + s.n, 0) : 0;
if (dN) {
  console.log(`TOTAL directional P&L: $${f2(dTotal)}   win rate ${(dWins / dN * 100).toFixed(0)}% (${dWins}/${dN})   avg win $${f2(dWins ? winSum / dWins : 0)}   avg loss $${f2(dN - dWins ? lossSum / (dN - dWins) : 0)}`);
  console.log('by exit reason: ' + Object.keys(byReason).map(k => `${k}: ${byReason[k].n} ($${f2(byReason[k].pl)})`).join('   '));

  // peak concurrent premium outlay (sweep over entry/exit boundaries)
  const events = [];
  for (const iv of intervals) { events.push([iv.start, iv.outlay, iv.day]); events.push([iv.end, -iv.outlay, iv.day]); }
  events.sort((a, b) => a[0] - b[0]);
  let cur = 0, peak = 0, peakDay = '';
  for (const [, delta, day] of events) { cur += delta; if (cur > peak) { peak = cur; peakDay = day; } }
  const dailyOutlay = {};
  for (const iv of intervals) dailyOutlay[iv.day] = (dailyOutlay[iv.day] || 0) + iv.outlay;
  const days = Object.keys(dailyOutlay).length;
  console.log(`\nDirectional capital: peak CONCURRENT outlay $${f2(peak)} (${peakDay})   trading days: ${days}   avg total outlay/day $${f2(Object.values(dailyOutlay).reduce((a, b) => a + b, 0) / days)}`);
  for (const acct of SIZES) console.log(`  vs $${acct}: peak concurrent = ${pct(peak, acct)} of account`);
  console.log(`  NOTE: directional risk is the premium outlay (long options); concurrent outlay = worst-case simultaneous loss.`);
}

/* ============================== COMBINED ================================== */
if (dvals.length && dN) {
  console.log('\n' + '='.repeat(78));
  const pmPeak = Math.max(...dvals);
  const events = [];
  for (const iv of intervals) { events.push([iv.start, iv.outlay]); events.push([iv.end, -iv.outlay]); }
  events.sort((a, b) => a[0] - b[0]);
  let cur = 0, dirPeak = 0;
  for (const [, delta] of events) { cur += delta; dirPeak = Math.max(dirPeak, cur); }
  const combined = pmPeak + dirPeak;
  console.log(`COMBINED worst case (premium peak day + directional peak concurrency): $${f2(combined)}`);
  for (const acct of SIZES) console.log(`  vs $${acct}: ${pct(combined, acct)} of account`);
  console.log('(conservative: assumes both peaks land the same day AND everything maxes out)');
}
