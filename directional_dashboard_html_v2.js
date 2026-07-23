#!/usr/bin/env node
/* directional_dashboard_html.js — Directional Options (Scout/Options Prime) Daily Dashboard
 * v2 — now applies a correction for the 32 early trades (Jun29-Jul7 2026) whose original
 * mfe.jsonl tracking was found to be unreliable (the arm/trail logic wasn't functioning
 * correctly during that window — see mfe_corrections.json / memory for the full
 * investigation). Those 32 trades' true outcomes were re-derived from real Databento
 * 1-min options price bars (cost: $2.80) and are applied here via exact-timestamp lookup.
 * All other trades (Jul 8 2026 onward) use the original mfe.jsonl data as-is, since
 * internal evidence (working arm/trail logic, sensible win-rate variation by exit type)
 * gives real confidence they reflect genuine intraday tracking.
 *
 * Reads: mfe.jsonl (raw trade log) + mfe_corrections.json (Databento-verified overrides
 * for the 32 early trades, keyed by exact ts)
 * Writes: directional_dashboards/YYYY-MM-DD.html + directional_dashboards/latest.html
 * View:   scp root@VPS:~/ibkr-webhook/directional_dashboards/latest.html . && open latest.html
 * Cron (suggested — run daily after market close, e.g. 4:15pm ET / 21:15 UTC):
 *   15 21 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node directional_dashboard_html.js >> directional_dashboard.out 2>&1
 */

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
// Server TZ is UTC; CT (summer/CDT) = UTC-5. At DST change (Nov 1 2026) this
// needs to shift to UTC-6, matching the same convention already used in
// the crontab comments for this server.
const CT_OFFSET_HOURS = 5;
function toCTDateStr(isoTs) {
  if (!isoTs) return '';
  const d = new Date(isoTs);
  const ctMs = d.getTime() - CT_OFFSET_HOURS * 60 * 60 * 1000;
  return new Date(ctMs).toISOString().slice(0, 10);
}
const today = toCTDateStr(new Date().toISOString());

function readJsonl(file) {
  try {
    return fs.readFileSync(path.join(DIR, file), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) { return []; }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
  } catch (e) { return []; }
}

const rawTrades = readJsonl('mfe.jsonl');
const corrections = readJson('mfe_corrections.json');

// Build a correction lookup keyed by ts. A few timestamps in mfe.jsonl are exact
// duplicates (same millisecond, different symbol) — those correction entries use a
// "_1"/"_2" suffixed key and are matched by ts + position among duplicates.
const correctionMap = {};
const seenTs = {};
for (const c of corrections) {
  correctionMap[c.ts] = c;
}

// ---- Apply corrections ----
const tsOccurrence = {};
const trades = rawTrades.map((t) => {
  const baseTs = t.ts;
  tsOccurrence[baseTs] = (tsOccurrence[baseTs] || 0) + 1;
  const occurrence = tsOccurrence[baseTs];

  let corr = correctionMap[baseTs];
  if (!corr && occurrence > 1) corr = correctionMap[`${baseTs}_${occurrence}`];
  if (!corr && correctionMap[`${baseTs}_1`] && occurrence === 1) corr = correctionMap[`${baseTs}_1`];

  const pnl = corr ? corr.pnl : (t.pnlPctApprox || 0);
  const reason = corr ? corr.reason : t.reason;

  const dollarPnl = (t.entryPrice || 0) * (pnl / 100) * (t.qty || 1) * 100;
  return {
    ...t,
    dateStr: toCTDateStr(t.ts),
    pnlPctApprox_final: pnl,
    dollarPnl_final: dollarPnl,
    reason_final: reason,
    isWin: pnl > 0,
    dataSource: corr ? 'databento_verified' : 'original',
  };
});

const total = trades.length;
const wins = trades.filter((t) => t.isWin).length;
const winRate = total ? (100 * wins / total) : 0;
const meanPnl = total ? trades.reduce((s, t) => s + t.pnlPctApprox_final, 0) / total : 0;
const verifiedCount = trades.filter((t) => t.dataSource === 'databento_verified').length;

// ---- Cumulative P&L% over time ----
const sorted = [...trades].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
let cum = 0;
const cumSeries = sorted.map((t) => { cum += t.pnlPctApprox_final; return { date: t.dateStr, cum }; });
let cumDollar = 0;
const cumDollarSeries = sorted.map((t) => { cumDollar += t.dollarPnl_final; return { date: t.dateStr, cum: cumDollar }; });
const totalDollarPnl = trades.reduce((s, t) => s + t.dollarPnl_final, 0);

// ---- By exit reason ----
const reasons = [...new Set(trades.map((t) => t.reason_final))].filter(Boolean);
const byReason = reasons.map((r) => {
  const sub = trades.filter((t) => t.reason_final === r);
  const w = sub.filter((t) => t.isWin).length;
  const mp = sub.length ? sub.reduce((s, t) => s + t.pnlPctApprox_final, 0) / sub.length : 0;
  return { reason: r, n: sub.length, wr: sub.length ? (100 * w / sub.length) : 0, meanPnl: mp };
});

// ---- By symbol ----
const symbols = [...new Set(trades.map((t) => t.symbol))].filter(Boolean).sort();
const bySymbol = symbols.map((s) => {
  const sub = trades.filter((t) => t.symbol === s);
  const w = sub.filter((t) => t.isWin).length;
  const mp = sub.length ? sub.reduce((s2, t) => s2 + t.pnlPctApprox_final, 0) / sub.length : 0;
  return { symbol: s, n: sub.length, wr: sub.length ? (100 * w / sub.length) : 0, meanPnl: mp };
}).sort((a, b) => b.n - a.n);

// ---- Today's trades ----
const todayTrades = trades.filter((t) => t.dateStr === today);
const todayDollarPnl = todayTrades.reduce((s, t) => s + t.dollarPnl_final, 0);

// ---- Daily rollup (last 20 active days) ----
const dailyMap = {};
for (const t of trades) {
  if (!dailyMap[t.dateStr]) dailyMap[t.dateStr] = { n: 0, sumPnl: 0, sumDollar: 0, wins: 0, verified: 0 };
  dailyMap[t.dateStr].n += 1;
  dailyMap[t.dateStr].sumPnl += t.pnlPctApprox_final;
  dailyMap[t.dateStr].sumDollar += t.dollarPnl_final;
  if (t.isWin) dailyMap[t.dateStr].wins += 1;
  if (t.dataSource === 'databento_verified') dailyMap[t.dateStr].verified += 1;
}
const dailyDates = Object.keys(dailyMap).sort().slice(-20);

function lineChart(vals) {
  if (!vals.length) return '<div class="empty">no data yet</div>';
  const W = 640, H = 220, PAD = 40;
  const mx = Math.max(...vals, 1), mn = Math.min(...vals, 0);
  const x = (i) => PAD + (i * (W - 2 * PAD)) / Math.max(vals.length - 1, 1);
  const y = (v) => H - PAD - ((v - mn) * (H - 2 * PAD)) / ((mx - mn) || 1);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="#4d8de8" stroke-width="2.5"/>
    <text x="${x(vals.length - 1) - 8}" y="${y(vals[vals.length - 1]) - 14}" style="font-size:15px;font-weight:700;text-anchor:end" fill="#eaf1ff">${vals[vals.length - 1].toFixed(0)}%</text>
    <line x1="${PAD}" y1="${y(0)}" x2="${W - PAD}" y2="${y(0)}" stroke="#555" stroke-dasharray="3"/></svg>`;
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Directional Options Dashboard — ${today}</title>
<style>
  body { background:#0f1218; color:#eaf1ff; font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 22px; } h2 { font-size: 16px; color:#a9b4c9; margin-bottom: 8px; }
  .sub { color:#8b98b0; font-size: 13px; margin-bottom: 1rem; }
  .banner { background:#1d2a1f; border:1px solid #2e5a34; border-radius: 8px; padding: 10px 14px; font-size: 12px; color:#9fd9a8; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 14px; margin-bottom: 1.5rem; }
  .card { background:#171c26; border-radius: 12px; padding: 16px; }
  .stat { display:inline-block; margin-right: 20px; }
  .n { font-size: 24px; font-weight: 600; } .l { font-size: 12px; color:#8b98b0; }
  .pos { color:#2e9e5b; } .neg { color:#d64545; }
  table { width:100%; border-collapse: collapse; font-size: 13px; }
  td, th { padding: 6px 8px; text-align:left; border-bottom: 1px solid #262d3d; }
  th { color:#8b98b0; font-size: 11px; text-transform: uppercase; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; background:#2e5a34; color:#9fd9a8; margin-left:6px; }
</style></head><body>
<h1>📊 Directional Options (Scout/Options Prime) — Daily Dashboard</h1>
<div class="sub">${today} · ${total} total trades since ${sorted[0] ? sorted[0].dateStr : 'n/a'}</div>
<div class="banner">✓ Data quality corrected: ${verifiedCount} early trades (Jun 29–Jul 7) re-derived from real Databento 1-min options price bars after the original tracking for that window was found unreliable. Remaining ${total - verifiedCount} trades use original mfe.jsonl data, confirmed internally consistent.</div>

<div class="grid">
  <div class="card">
    <div class="stat"><div class="n ${winRate >= 60 ? 'pos' : ''}">${winRate.toFixed(1)}%</div><div class="l">win rate (${wins}/${total})</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n ${meanPnl >= 0 ? 'pos' : 'neg'}">${meanPnl >= 0 ? '+' : ''}${meanPnl.toFixed(1)}%</div><div class="l">mean P&L per trade</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n ${cum >= 0 ? 'pos' : 'neg'}">${cum >= 0 ? '+' : ''}${cum.toFixed(0)}%</div><div class="l">cumulative P&L% (sum)</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n ${totalDollarPnl >= 0 ? 'pos' : 'neg'}">${totalDollarPnl >= 0 ? '+' : '-'}$${Math.abs(totalDollarPnl).toFixed(2)}</div><div class="l">cumulative P&L ($)</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n">${todayTrades.length}</div><div class="l">trades today</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n ${todayDollarPnl >= 0 ? 'pos' : 'neg'}">${todayDollarPnl >= 0 ? '+' : '-'}$${Math.abs(todayDollarPnl).toFixed(2)}</div><div class="l">today's P&L ($)</div></div>
  </div>
</div>

<div class="card" style="margin-bottom:1.5rem"><h2>Cumulative P&L% over time</h2>${lineChart(cumSeries.map((c) => c.cum))}</div>

<div class="grid">
  <div class="card">
    <h2>By exit reason</h2>
    <table><tr><th>Reason</th><th>N</th><th>WR</th><th>Mean P&L%</th></tr>
      ${byReason.map((r) => `<tr><td>${r.reason}</td><td>${r.n}</td><td>${r.wr.toFixed(1)}%</td><td class="${r.meanPnl >= 0 ? 'pos' : 'neg'}">${r.meanPnl >= 0 ? '+' : ''}${r.meanPnl.toFixed(1)}%</td></tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <h2>By symbol</h2>
    <table><tr><th>Sym</th><th>N</th><th>WR</th><th>Mean P&L%</th></tr>
      ${bySymbol.map((s) => `<tr><td>${s.symbol}</td><td>${s.n}</td><td>${s.wr.toFixed(1)}%</td><td class="${s.meanPnl >= 0 ? 'pos' : 'neg'}">${s.meanPnl >= 0 ? '+' : ''}${s.meanPnl.toFixed(1)}%</td></tr>`).join('')}
    </table>
  </div>
</div>

<div class="card" style="margin-bottom:1.5rem">
  <h2>Today's trades (${todayTrades.length})</h2>
  ${todayTrades.length ? `<table><tr><th>Time</th><th>Symbol</th><th>Right</th><th>Strike</th><th>Reason</th><th>P&L%</th><th>P&L $</th></tr>
    ${todayTrades.map((t) => `<tr><td>${(t.ts || '').slice(11, 16)}</td><td>${t.symbol}</td><td>${t.right}</td><td>${t.strike}</td><td>${t.reason_final}</td><td class="${t.isWin ? 'pos' : 'neg'}">${t.pnlPctApprox_final >= 0 ? '+' : ''}${t.pnlPctApprox_final.toFixed(1)}%</td><td class="${t.dollarPnl_final >= 0 ? 'pos' : 'neg'}">${t.dollarPnl_final >= 0 ? '+' : '-'}$${Math.abs(t.dollarPnl_final).toFixed(2)}</td></tr>`).join('')}
    </table>` : '<div class="l">No trades today.</div>'}
</div>

<div class="card">
  <h2>Daily rollup (last 20 active days)</h2>
  <table><tr><th>Date</th><th>Trades</th><th>Wins</th><th>WR</th><th>Sum P&L%</th><th>Sum P&L $</th></tr>
    ${dailyDates.map((d) => {
      const day = dailyMap[d];
      const wr = day.n ? (100 * day.wins / day.n) : 0;
      const verifiedBadge = day.verified > 0 ? `<span class="badge">${day.verified} verified</span>` : '';
      return `<tr><td>${d}${verifiedBadge}</td><td>${day.n}</td><td>${day.wins}</td><td>${wr.toFixed(0)}%</td><td class="${day.sumPnl >= 0 ? 'pos' : 'neg'}">${day.sumPnl >= 0 ? '+' : ''}${day.sumPnl.toFixed(1)}%</td><td class="${day.sumDollar >= 0 ? 'pos' : 'neg'}">${day.sumDollar >= 0 ? '+' : '-'}$${Math.abs(day.sumDollar).toFixed(2)}</td></tr>`;
    }).join('')}
  </table>
</div>

</body></html>`;

const outDir = path.join(DIR, 'directional_dashboards');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
fs.writeFileSync(path.join(outDir, `${today}.html`), html);
fs.writeFileSync(path.join(outDir, 'latest.html'), html);
console.log(`[directional_dashboard_html v2] wrote directional_dashboards/${today}.html and latest.html`);
console.log(`Total trades: ${total} (${verifiedCount} Databento-verified), Win rate: ${winRate.toFixed(1)}%, Mean P&L: ${meanPnl.toFixed(1)}%, Cumulative: ${cum.toFixed(1)}% ($${totalDollarPnl >= 0 ? "+" : "-"}${Math.abs(totalDollarPnl).toFixed(2)}), Today: $${todayDollarPnl >= 0 ? "+" : "-"}${Math.abs(todayDollarPnl).toFixed(2)}`);
