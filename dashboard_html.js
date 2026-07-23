#!/usr/bin/env node
/* dashboard_html.js — visual Readiness Dashboard v1.1 (10-second front page).
 * v1.1 adds: drawdown card, risk/band card, regime weather strip (context ONLY,
 * never recommendations), instrument breakdown, monthly calendar, rolling win
 * rates (grayed until windows fill). Pure rendering — reads jsonl, touches nothing.
 *
 * Writes dashboards/YYYY-MM-DD.html + dashboards/latest.html
 * View:  scp root@VPS:~/ibkr-webhook/dashboards/latest.html . && open latest.html
 * Cron:  46 20 * * 1-5 cd /root/ibkr-webhook && /usr/bin/node dashboard_html.js >> dashboard.out 2>&1
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const DIR = __dirname;
const LIVE = { variant: 'vol_wide', symbols: ['XSP', 'IWM'] };
const EQUITY = +(process.env.ACCOUNT_EQUITY || 6000);   // planned live account for band math
const jl = (f) => { try { return fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const today = new Date().toISOString().slice(0, 10);

const settles = jl('pmtracker_multi_log.jsonl').filter((r) => r.real_pl != null && r.intended_fly);
const ratios = jl('credit_verification.jsonl').filter((r) => r.ratio != null);
const ledger = jl('fly_ledger.jsonl');
const marks = jl('fly_marks.jsonl').filter((m) => m.quotes_ok);

const lb = settles.filter((r) => r.variant === LIVE.variant && LIVE.symbols.includes(r.symbol));
const days = [...new Set(lb.map((r) => r.date))].sort();
const dayPlMap = {}; for (const d of days) dayPlMap[d] = lb.filter((r) => r.date === d).reduce((s, r) => s + r.real_pl, 0);
const dayPl = days.map((d) => dayPlMap[d]);
const cum = []; let c = 0; for (const p of dayPl) { c += p; cum.push(c); }
const fills = ledger.filter((e) => e.event === 'filled');
const unresolved = Object.entries(ledger.reduce((m, e) => ((m[e.flyId] = e.event), m), {})).filter(([, ev]) => ev === 'orphan_unresolved').length;
const rAvg = ratios.length ? ratios.reduce((s, r) => s + r.ratio, 0) / ratios.length : null;
const rToday = ratios.filter((r) => r.date === today);
const mToday = marks.filter((m) => m.date === today && m.variant === LIVE.variant);

/* ---- drawdown ---- */
let peak = 0, worstDD = 0, curDD = 0, daysSinceHigh = 0;
cum.forEach((v, i) => { if (v >= peak) { peak = v; daysSinceHigh = cum.length - 1 - i; } worstDD = Math.max(worstDD, peak - v); });
curDD = peak - (cum[cum.length - 1] ?? 0);

/* ---- risk / band (today's live-book rows) ---- */
const lbToday = lb.filter((r) => r.date === today);
const deployedRows = lbToday.length ? lbToday : lb.filter((r) => r.date === days[days.length - 1]);
const maxLossOf = (r) => (r.intended_fly.max_loss ?? r.intended_fly.maxloss ?? (r.intended_fly.wing_pts * 100 - r.intended_fly.model_credit)) * (r.contracts || 1);
const deployed = deployedRows.reduce((s, r) => s + Math.max(0, maxLossOf(r)), 0);
const bandPct = deployed / EQUITY;

/* ---- regime weather (context only — no recommendations by design) ---- */
let regime = null;
try {
  const yq = (s) => JSON.parse(execSync(`curl -s -m 12 -H 'User-Agent: Mozilla/5.0' "https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1mo"`).toString()).chart.result[0];
  const vix = yq('^VIX'), spy = yq('SPY');
  const vc = vix.indicators.quote[0].close.filter((x) => x != null);
  const sc = spy.indicators.quote[0].close.filter((x) => x != null);
  const vNow = vc[vc.length - 1], vPrev = vc[vc.length - 2];
  const s5 = (sc[sc.length - 1] / sc[sc.length - 6] - 1) * 100;
  const label = vNow < 14 ? 'CALM (floor territory)' : vNow < 20 ? 'NORMAL' : vNow < 30 ? 'ELEVATED' : 'STRESSED (gate zone)';
  regime = { vNow, chg: (vNow / vPrev - 1) * 100, s5, label };
} catch (e) { /* offline render is fine */ }

/* ---- rolling win rates (grayed until windows fill) ---- */
const wr = (n) => { const w = dayPl.slice(-n); return w.length ? { rate: w.filter((x) => x > 0).length / w.length, n: w.length, full: w.length >= n } : null; };
const rolls = [['20-day', wr(20)], ['60-day', wr(60)], ['YTD', { rate: dayPl.filter((x) => x > 0).length / (dayPl.length || 1), n: dayPl.length, full: dayPl.length >= 10 }]];

/* ---- charts ---- */
const W = 640, H = 220, PAD = 40;
function lineChart(vals, labels, color) {
  if (!vals.length) return `<div class="empty">no data yet</div>`;
  const mx = Math.max(...vals, 1), mn = Math.min(...vals, 0);
  const x = (i) => PAD + (i * (W - 2 * PAD)) / Math.max(vals.length - 1, 1);
  const y = (v) => H - PAD - ((v - mn) * (H - 2 * PAD)) / (mx - mn || 1);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"/>
    ${vals.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3.5" fill="${color}"/><text x="${x(i)}" y="${H - PAD + 16}" class="tick">${labels[i].slice(5)}</text>`).join('')}
    <text x="${x(vals.length - 1) - 8}" y="${y(vals[vals.length - 1]) - 14}" style="font-size:15px;font-weight:700;text-anchor:end" fill="#eaf1ff">$${(vals[vals.length - 1]).toLocaleString(undefined, { maximumFractionDigits: 0 })}</text>
    <line x1="${PAD}" y1="${y(0)}" x2="${W - PAD}" y2="${y(0)}" stroke="#555" stroke-dasharray="3"/></svg>`;
}
function barChart(vals, labels) {
  if (!vals.length) return `<div class="empty">no data yet</div>`;
  const mx = Math.max(...vals.map(Math.abs), 1);
  const bw = Math.min(60, (W - 2 * PAD) / vals.length - 10);
  const x = (i) => PAD + i * ((W - 2 * PAD) / vals.length) + 5;
  const zero = H / 2;
  return `<svg viewBox="0 0 ${W} ${H}"><line x1="${PAD}" y1="${zero}" x2="${W - PAD}" y2="${zero}" stroke="#555"/>
    ${vals.map((v, i) => { const h = (Math.abs(v) / mx) * (H / 2 - PAD); const yy = v >= 0 ? zero - h : zero; return `<rect x="${x(i)}" y="${yy}" width="${bw}" height="${Math.max(h, 1)}" rx="4" fill="${v >= 0 ? '#2e9e5b' : '#d64545'}"/><text x="${x(i) + bw / 2}" y="${v >= 0 ? yy - 6 : yy + h + 14}" class="val" fill="${v >= 0 ? '#2e9e5b' : '#d64545'}">$${v.toFixed(0)}</text><text x="${x(i) + bw / 2}" y="${H - 8}" class="tick">${labels[i].slice(5)}</text>`; }).join('')}</svg>`;
}
function calendar() {
  const now = new Date();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1)), dow0 = first.getUTCDay();
  const dim = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const cell = 40, gap = 6;
  let svg = `<svg viewBox="0 0 ${7 * (cell + gap)} ${7 * (cell + gap)}">`;
  'SMTWTFS'.split('').forEach((d, i) => svg += `<text x="${i * (cell + gap) + cell / 2}" y="14" class="tick">${d}</text>`);
  for (let d = 1; d <= dim; d++) {
    const dt = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const col = (dow0 + d - 1) % 7, row = Math.floor((dow0 + d - 1) / 7) + 1;
    const pl = dayPlMap[dt];
    const fill = pl == null ? '#20263466' : pl > 50 ? '#2e9e5b' : pl >= -50 ? '#e8b44a' : '#d64545';
    svg += `<rect x="${col * (cell + gap)}" y="${row * (cell + gap)}" width="${cell}" height="${cell}" rx="7" fill="${fill}"/>
      <text x="${col * (cell + gap) + cell / 2}" y="${row * (cell + gap) + 17}" class="tick" fill="#dde3ee">${d}</text>
      ${pl != null ? `<text x="${col * (cell + gap) + cell / 2}" y="${row * (cell + gap) + 32}" class="cval">$${pl.toFixed(0)}</text>` : ''}`;
  }
  return svg + '</svg>';
}
function gauge(label, val, warn = 0.7) {
  const p = Math.min(1, Math.max(0, val ?? 0));
  const color = val == null ? '#555' : p > warn ? '#d64545' : p > warn * 0.7 ? '#e8b44a' : '#2e9e5b';
  return `<div class="gauge"><div class="glabel">${label}</div><div class="gbar"><div class="gfill" style="width:${p * 100}%;background:${color}"></div></div><div class="gval" style="color:${color}">${val == null ? '—' : (p * 100).toFixed(0) + '%'}</div></div>`;
}

/* ---- instrument breakdown ---- */
const instr = LIVE.symbols.map((sym) => {
  const rows = lb.filter((r) => r.symbol === sym);
  if (!rows.length) return `<tr><td>${sym}</td><td colspan="4" class="muted">no rows</td></tr>`;
  const pl = rows.reduce((s, r) => s + r.real_pl, 0);
  const wins = rows.filter((r) => r.real_pl > 0).length;
  const capt = rows.reduce((s, r) => s + r.real_pl / (r.intended_fly.model_credit * (r.contracts || 1)), 0) / rows.length;
  return `<tr><td><b>${sym}</b></td><td class="${pl >= 0 ? 'pos' : 'neg'}">$${pl.toFixed(0)}</td><td>${wins}/${rows.length}</td><td>${(capt * 100).toFixed(0)}%</td><td>${rows.filter((r) => r.was_max_loss).length}</td></tr>`;
}).join('');

/* ---- capital readiness (pre-live: planned capital until fill sample exists) ---- */
const ML_CT = 800;
const rungEq = (n) => Math.round(n * ML_CT / 0.15);
const curCts = Math.max(1, Math.floor(0.15 * EQUITY / ML_CT));
const nextEq = rungEq(curCts + 1), floorEq = rungEq(curCts);
const rungProg = Math.min(1, Math.max(0, (EQUITY - floorEq) / (nextEq - floorEq)));
const avgDayPace = dayPl.length ? dayPl.reduce((a, b) => a + b, 0) / dayPl.length : 0;
const daysToNext = avgDayPace > 0 ? Math.ceil((nextEq - EQUITY) / avgDayPace) : null;
const liveMode = fills.length >= 5;

const checks = [
  [days.length >= 30, `30+ tracked days (${days.length}/30)`],
  [fills.length >= 5, `5+ real fills (${fills.length}/5)`],
  [ratios.length >= 5, `5+ honesty readings (${ratios.length}/5)`],
  [rAvg != null && rAvg >= 0.75 && ratios.length >= 5, `trailing ratio ≥ 0.75 ${rAvg ? '(' + rAvg.toFixed(3) + ')' : ''}`],
  [unresolved === 0, `zero unresolved orphans`],
  [false, `kill-criteria document`],
  [false, `live second-username setup`],
];
const done = checks.filter(([ok]) => ok).length;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fly Dashboard — ${today}</title><style>
body{background:#12151c;color:#dde3ee;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;margin:0;padding:24px}
h1{font-size:22px;margin:0 0 4px}.sub{color:#7a869c;font-size:13px;margin-bottom:14px}
.strip{background:#1a1f2b;border:1px solid #262d3d;border-radius:10px;padding:10px 16px;margin-bottom:16px;font-size:13px;color:#a9b4c9}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
.card{background:#1a1f2b;border:1px solid #262d3d;border-radius:14px;padding:18px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:#8b98b0;margin:0 0 12px}
.big{font-size:32px;font-weight:700}.pos{color:#2e9e5b}.neg{color:#d64545}.warn{color:#e8b44a}.muted{color:#7a869c;font-size:12px}
svg{width:100%;height:auto}.tick{font-size:10px;fill:#7a869c;text-anchor:middle}.val{font-size:11px;font-weight:600;text-anchor:middle}
.cval{font-size:8.5px;fill:#12151c;font-weight:700;text-anchor:middle}
.empty{color:#555;padding:30px;text-align:center}
.gauge{display:flex;align-items:center;gap:10px;margin:8px 0}.glabel{width:180px;font-size:12px;color:#a9b4c9}
.gbar{flex:1;height:10px;background:#262d3d;border-radius:5px;overflow:hidden}.gfill{height:100%;border-radius:5px}
.gval{width:44px;font-size:13px;font-weight:700;text-align:right}
.check{margin:6px 0;font-size:14px}.check .ok{color:#2e9e5b}.check .no{color:#555}
.stat{display:inline-block;margin-right:24px;margin-bottom:8px}.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:11px;color:#7a869c}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 8px;text-align:left;border-bottom:1px solid #262d3d}th{color:#8b98b0;font-size:11px;text-transform:uppercase}
.meter{height:16px;background:#262d3d;border-radius:8px;overflow:hidden;margin:8px 0}.mfill{height:100%;background:linear-gradient(90deg,#2e9e5b,#4d8de8)}
</style></head><body>
<h1>🪰 Premium Engine — Readiness Dashboard <span class="muted">v1.1</span></h1>
<div class="sub">${today} · vol_wide XSP+IWM · model credits until fill sample matures</div>
${regime ? `<div class="strip"><b>Regime (context only):</b> VIX ${regime.vNow.toFixed(1)} (${regime.chg >= 0 ? '+' : ''}${regime.chg.toFixed(1)}% d/d) · SPY 5-day ${regime.s5 >= 0 ? '+' : ''}${regime.s5.toFixed(1)}% · <b>${regime.label}</b> — sizing is governed by the band & ladder, never by this strip</div>` : ''}
<div class="grid">
<div class="card"><h2>Fill honesty (model vs market)</h2>
  <div class="big ${rAvg == null ? '' : rAvg >= 0.75 ? 'pos' : 'neg'}">${rAvg == null ? '—' : rAvg.toFixed(3)}</div>
  <div class="muted">trailing avg over ${ratios.length} readings${rToday.length ? ' · today: ' + rToday.map((r) => `${r.symbol} ${r.ratio.toFixed(2)}`).join(', ') : ' · first reading prints 9:44 ET'}</div></div>
<div class="card"><h2>Drawdown</h2>
  <span class="stat"><div class="n ${curDD > 0 ? 'warn' : 'pos'}">$${curDD.toFixed(0)}</div><div class="l">current drawdown</div></span>
  <span class="stat"><div class="n">$${worstDD.toFixed(0)}</div><div class="l">worst historical</div></span>
  <span class="stat"><div class="n">${daysSinceHigh}</div><div class="l">days since equity high</div></span></div>
<div class="card"><h2>Risk / band</h2>
  <span class="stat"><div class="n">$${deployed.toFixed(0)}</div><div class="l">capital deployed (max loss)</div></span>
  <span class="stat"><div class="n ${bandPct > 0.15 ? 'neg' : 'pos'}">${(bandPct * 100).toFixed(1)}%</div><div class="l">of $${EQUITY.toLocaleString()} equity (band: 15%)</div></span>
  <span class="stat"><div class="n ${unresolved ? 'neg' : 'pos'}">${unresolved}</div><div class="l">unresolved orphans</div></span></div>
<div class="card" style="grid-column:1/-1"><h2>Live book — cumulative P&L</h2>${lineChart(cum, days, '#4d8de8')}</div>
<div class="card" style="grid-column:1/-1"><h2>Daily P&L</h2>${barChart(dayPl, days)}</div>
<div class="card"><h2>Monthly calendar</h2>${calendar()}</div>
<div class="card"><h2>Instrument breakdown</h2>
  <table><tr><th>sym</th><th>P&L</th><th>green days</th><th>avg capture</th><th>max-loss</th></tr>${instr}</table>
  <div style="margin-top:14px">${(() => { const g = []; for (const sym of LIVE.symbols) { const rows = lb.filter((r) => r.symbol === sym); if (!rows.length) continue; const usage = Math.max(...rows.map((r) => { const kept = r.real_pl / (r.contracts || 1) / 100; return Math.min(1, Math.max(0, r.intended_fly.model_credit / 100 - kept) / r.intended_fly.wing_pts); })); g.push(gauge(`${sym} max wing usage`, usage, 0.7)); } return g.join(''); })()}</div></div>
<div class="card"><h2>Rolling win rate</h2>
  ${rolls.map(([l, r]) => r ? `<div class="gauge"><div class="glabel">${l}${r.full ? '' : ` <span class="muted">(n=${r.n} — filling)</span>`}</div><div class="gbar"><div class="gfill" style="width:${r.rate * 100}%;background:${r.full ? '#2e9e5b' : '#555'}"></div></div><div class="gval">${(r.rate * 100).toFixed(0)}%</div></div>` : '').join('')}
  <div class="muted" style="margin-top:6px">18-mo reference: 87% (XSP) / 75% (IWM) win days</div></div>
<div class="card"><h2>Intraday (real marks, today)</h2>${mToday.length ? LIVE.symbols.map((s) => { const ms = mToday.filter((m) => m.symbol === s); return ms.length ? gauge(`${s} — last mark (% of credit)`, ms[ms.length - 1].pl_pct_of_credit / 100, 2) : ''; }).join('') : '<div class="empty">marks begin 9:50 ET</div>'}</div>
<div class="card"><h2>Capital readiness ${liveMode ? '' : '· <span style="color:#e8b44a">PRE-LIVE (planned capital)</span>'}</h2>
  <span class="stat"><div class="n">$${EQUITY.toLocaleString()}</div><div class="l">equity (ACCOUNT_EQUITY)</div></span>
  <span class="stat"><div class="n">${curCts}</div><div class="l">ladder contracts @ 15%</div></span>
  <div style="margin-top:8px;font-size:12px;color:#a9b4c9">next rung: <b>${curCts + 1} contracts at $${nextEq.toLocaleString()}</b></div>
  <div class="meter"><div class="mfill" style="width:${(rungProg * 100).toFixed(0)}%"></div></div>
  <div class="muted">$${(nextEq - EQUITY).toLocaleString()} to go${daysToNext ? ` · ~${daysToNext} days at trailing tracked pace (paper 2-lot — indicative only)` : ''}</div>
  <div class="muted" style="margin-top:8px">de-scale rung: below $${floorEq.toLocaleString()} → ${curCts - 1 > 0 ? (curCts - 1) + ' contract' + (curCts - 1 > 1 ? 's' : '') : 'PAUSED (below minimum)'} — the ladder is law in both directions</div>
</div>
<div class="card"><h2>Promotion progress — ${done}/${checks.length}</h2>
  <div class="meter"><div class="mfill" style="width:${(done / checks.length) * 100}%"></div></div>
  ${checks.map(([ok, l]) => `<div class="check"><span class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '○'}</span> ${l}</div>`).join('')}</div>
</div></body></html>`;

const dir = path.join(DIR, 'dashboards');
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
fs.writeFileSync(path.join(dir, `${today}.html`), html);
fs.writeFileSync(path.join(dir, 'latest.html'), html);
console.log(`[dashboard_html v1.1] wrote dashboards/${today}.html and latest.html`);
