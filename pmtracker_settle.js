/**
 * pmtracker_settle.js — end-of-day settlement for the premium-selling tracker.
 * ---------------------------------------------------------------------------
 * Reads pmtracker_multi_log.jsonl, finds unsettled trade rows (real_pl == null),
 * pulls each symbol's official close from Yahoo, computes terminal iron-fly P&L
 * against the logged strikes, and writes the outcome fields back in.
 *
 * Fills:  real_pl, vix_close, was_max_loss, gate_held, settle_close, settle_src, settled_at
 * Idempotent: only touches rows where real_pl is still null.
 * Safe write: backs up to .bak and writes atomically (temp + rename).
 *
 * Usage:
 *   node pmtracker_settle.js                 # settle all unsettled past days + today-after-close
 *   node pmtracker_settle.js 2026-07-01      # settle only that date
 *   node pmtracker_settle.js 2026-07-01 --force   # ...even if before today's close (testing)
 *
 * Cron (after the official close is finalized — verify server tz with `date`):
 *   20 15 * * 1-5  cd /root/ibkr-webhook && /usr/bin/node pmtracker_settle.js >> settle.log 2>&1
 *   (15:20 CT / 16:20 ET leaves a buffer for Yahoo to finalize the daily close)
 * ---------------------------------------------------------------------------
 */

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOG = process.env.PM_LOG || path.join(process.cwd(), 'pmtracker_multi_log.jsonl');
const MULT = 100;                 // $/point — same for XSP/SPX index and SPY/QQQ/IWM equity options
const VIX_GATE_MAX = Number(process.env.VIX_GATE_MAX || 25); // set to match pmtracker_feed's entry gate

// symbol -> Yahoo ticker + divisor (XSP = SPX/10)
const YMAP = {
  XSP: { yahoo: '^GSPC', div: 10 },
  SPX: { yahoo: '^GSPC', div: 1  },
  SPY: { yahoo: 'SPY',   div: 1  },
  QQQ: { yahoo: 'QQQ',   div: 1  },
  IWM: { yahoo: 'IWM',   div: 1  },
};

// ---- date helpers (market tz = America/New_York) --------------------------
function nyDate(tsSeconds) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(tsSeconds * 1000));            // -> 'YYYY-MM-DD'
}
function nyNow() {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

// ---- Yahoo daily-close fetch (v8 chart; no crumb needed) -------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

// returns { 'YYYY-MM-DD': close } for the trailing month
async function fetchCloses(yahooSym) {
  const enc = encodeURIComponent(yahooSym);
  const paths = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${enc}?range=1mo&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${enc}?range=1mo&interval=1d`,
  ];
  let lastErr;
  for (const u of paths) {
    try {
      const j = JSON.parse(await httpGet(u));
      const r = j.chart.result[0];
      const ts = r.timestamp || [];
      const cl = r.indicators.quote[0].close || [];
      const out = {};
      for (let i = 0; i < ts.length; i++) if (cl[i] != null) out[nyDate(ts[i])] = cl[i];
      // include the live/last price under today's key as a fallback
      const meta = r.meta || {};
      if (meta.regularMarketPrice != null && meta.regularMarketTime != null) {
        out[nyDate(meta.regularMarketTime)] = meta.regularMarketPrice;
      }
      return out;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ---- terminal iron-fly P&L -------------------------------------------------
// credit is PER CONTRACT (verified: credit + maxloss == wingWidth * 100).
function flyPnL(f, credit, contracts, S) {
  // normalize schema: wingsweep rows nest strikes under f.strikes {short, long_call, long_put};
  // fixed/vol/condor rows have top-level short_call/short_put/long_call/long_put.
  const sc = (f.short_call != null) ? f.short_call : (f.strikes ? f.strikes.short : undefined);
  const sp = (f.short_put  != null) ? f.short_put  : (f.strikes ? f.strikes.short : undefined);
  const lc = (f.long_call  != null) ? f.long_call  : (f.strikes ? f.strikes.long_call : undefined);
  const lp = (f.long_put   != null) ? f.long_put   : (f.strikes ? f.strikes.long_put  : undefined);
  const shortCallOwed = Math.max(0, S - sc) * MULT;
  const shortPutOwed  = Math.max(0, sp - S) * MULT;
  const longCallVal   = Math.max(0, S - lc) * MULT;
  const longPutVal    = Math.max(0, lp - S) * MULT;
  const netOwed = shortCallOwed + shortPutOwed - longCallVal - longPutVal;
  const perContract = credit - netOwed;
  return perContract * contracts;
}

// ---- main ------------------------------------------------------------------
(async () => {
  const argDate = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
  const force   = process.argv.includes('--force');
  const now = nyNow();

  if (!fs.existsSync(LOG)) { console.error(`log not found: ${LOG}`); process.exit(1); }
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => JSON.parse(l));

  // which rows need settling
  const targets = rows.filter((r) => {
    if (!r.TRADE || r.real_pl != null) return false;
    if (argDate) return r.date === argDate;
    // no explicit date: settle past days always; today only after the close (buffer to 16:05 ET)
    if (r.date < now.date) return true;
    if (r.date === now.date) return force || (now.hour > 16 || (now.hour === 16 && now.minute >= 5));
    return false; // future-dated
  });

  if (!targets.length) { console.log('nothing to settle (all rows already have real_pl, or market not yet closed).'); return; }

  // fetch each needed underlying + VIX once
  const needed = new Set(targets.map((r) => YMAP[r.symbol]?.yahoo).filter(Boolean));
  needed.add('^VIX');
  const closesBySym = {};
  for (const y of needed) {
    try { closesBySym[y] = await fetchCloses(y); }
    catch (e) { console.error(`fetch failed for ${y}: ${e.message}`); closesBySym[y] = {}; }
  }

  const summary = [];
  let settled = 0;
  for (const r of targets) {
    const map = YMAP[r.symbol];
    if (!map) { console.error(`no Yahoo mapping for ${r.symbol}, skipping`); continue; }
    const rawClose = (closesBySym[map.yahoo] || {})[r.date];
    const vixClose = (closesBySym['^VIX'] || {})[r.date];
    if (rawClose == null) { console.error(`no close for ${r.symbol} on ${r.date}, skipping`); continue; }

    const S = rawClose / map.div;
    const credit = (r.real_fill_credit != null) ? r.real_fill_credit : r.intended_fly.model_credit;
    const pl = flyPnL(r.intended_fly, credit, r.contracts, S);

    r.real_pl       = Math.round(pl * 100) / 100;
    r.vix_close     = vixClose != null ? Math.round(vixClose * 100) / 100 : null;
    r.was_max_loss  = r.real_pl <= (-r.capital_at_risk + 1e-6);
    r.gate_held     = vixClose != null ? (vixClose <= VIX_GATE_MAX) : null;
    r.settle_close  = Math.round(S * 100) / 100;
    r.settle_src    = `YH:${map.yahoo}${map.div !== 1 ? '/' + map.div : ''}`;
    r.settled_at    = new Date().toISOString();
    settled++;
    summary.push({ date: r.date, sym: r.symbol, close: r.settle_close, center: r.intended_fly.center,
                   credit, pl: r.real_pl, maxloss: r.was_max_loss });
  }

  if (!settled) { console.log('no rows could be settled (missing closes).'); return; }

  // atomic write + backup
  fs.copyFileSync(LOG, LOG + '.bak');
  const tmp = LOG + '.tmp';
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, LOG);

  // report
  console.log(`\nSettled ${settled} row(s). Backup: ${path.basename(LOG)}.bak\n`);
  console.log('date        sym   close     center   credit    P&L        maxloss');
  console.log('----------  ----  --------  -------  --------  ---------  -------');
  let total = 0;
  for (const s of summary) {
    total += s.pl;
    console.log(
      `${s.date}  ${s.sym.padEnd(4)}  ${String(s.close).padStart(8)}  ${String(s.center).padStart(7)}  ` +
      `${s.credit.toFixed(2).padStart(8)}  ${(s.pl >= 0 ? '+' : '') + s.pl.toFixed(2).padStart(8)}  ${s.maxloss ? 'MAX' : ''}`
    );
  }
  console.log('----------  ----  --------  -------  --------  ---------  -------');
  console.log(`TOTAL across settled rows: ${(total >= 0 ? '+' : '') + total.toFixed(2)}`);
  console.log('\n(Note: SPX rows are 10x-sized reference-only; exclude from the $5k-account tally if desired.)');
})();
