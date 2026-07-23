path = "directional_dashboard_html_v2.js"
with open(path, "r") as f:
    content = f.read()

# 1. Add dollarPnl_final when building each trade
old1 = """  return {
    ...t,
    dateStr: (t.ts || '').slice(0, 10),
    pnlPctApprox_final: pnl,"""
new1 = """  const dollarPnl = (t.entryPrice || 0) * (pnl / 100) * (t.qty || 1) * 100;
  return {
    ...t,
    dateStr: (t.ts || '').slice(0, 10),
    pnlPctApprox_final: pnl,
    dollarPnl_final: dollarPnl,"""
if old1 not in content:
    print("ERROR: step 1 marker not found — aborting.")
    exit(1)
content = content.replace(old1, new1, 1)

# 2. Cumulative $ series (parallel to the existing % cumSeries)
old2 = """const cumSeries = sorted.map((t) => { cum += t.pnlPctApprox_final; return { date: t.dateStr, cum }; });"""
new2 = """const cumSeries = sorted.map((t) => { cum += t.pnlPctApprox_final; return { date: t.dateStr, cum }; });
let cumDollar = 0;
const cumDollarSeries = sorted.map((t) => { cumDollar += t.dollarPnl_final; return { date: t.dateStr, cum: cumDollar }; });
const totalDollarPnl = trades.reduce((s, t) => s + t.dollarPnl_final, 0);"""
if old2 not in content:
    print("ERROR: step 2 marker not found — aborting.")
    exit(1)
content = content.replace(old2, new2, 1)

# 3. Today's total $
old3 = """const todayTrades = trades.filter((t) => t.dateStr === today);"""
new3 = """const todayTrades = trades.filter((t) => t.dateStr === today);
const todayDollarPnl = todayTrades.reduce((s, t) => s + t.dollarPnl_final, 0);"""
if old3 not in content:
    print("ERROR: step 3 marker not found — aborting.")
    exit(1)
content = content.replace(old3, new3, 1)

# 4. Add sumDollar to daily rollup
old4 = """  if (!dailyMap[t.dateStr]) dailyMap[t.dateStr] = { n: 0, sumPnl: 0, wins: 0, verified: 0 };
  dailyMap[t.dateStr].n += 1;
  dailyMap[t.dateStr].sumPnl += t.pnlPctApprox_final;"""
new4 = """  if (!dailyMap[t.dateStr]) dailyMap[t.dateStr] = { n: 0, sumPnl: 0, sumDollar: 0, wins: 0, verified: 0 };
  dailyMap[t.dateStr].n += 1;
  dailyMap[t.dateStr].sumPnl += t.pnlPctApprox_final;
  dailyMap[t.dateStr].sumDollar += t.dollarPnl_final;"""
if old4 not in content:
    print("ERROR: step 4 marker not found — aborting.")
    exit(1)
content = content.replace(old4, new4, 1)

# 5. Add $ stat cards next to the existing % ones
old5 = """  <div class="card">
    <div class="stat"><div class="n ${cum >= 0 ? 'pos' : 'neg'}">${cum >= 0 ? '+' : ''}${cum.toFixed(0)}%</div><div class="l">cumulative P&L% (sum)</div></div>
  </div>
  <div class="card">
    <div class="stat"><div class="n">${todayTrades.length}</div><div class="l">trades today</div></div>
  </div>
</div>"""
new5 = """  <div class="card">
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
</div>"""
if old5 not in content:
    print("ERROR: step 5 marker not found — aborting.")
    exit(1)
content = content.replace(old5, new5, 1)

# 6. Add $ column to Today's trades table
old6 = """  ${todayTrades.length ? `<table><tr><th>Time</th><th>Symbol</th><th>Right</th><th>Strike</th><th>Reason</th><th>P&L%</th></tr>
    ${todayTrades.map((t) => `<tr><td>${(t.ts || '').slice(11, 16)}</td><td>${t.symbol}</td><td>${t.right}</td><td>${t.strike}</td><td>${t.reason_final}</td><td class="${t.isWin ? 'pos' : 'neg'}">${t.pnlPctApprox_final >= 0 ? '+' : ''}${t.pnlPctApprox_final.toFixed(1)}%</td></tr>`).join('')}
    </table>` : '<div class="l">No trades today.</div>'}"""
new6 = """  ${todayTrades.length ? `<table><tr><th>Time</th><th>Symbol</th><th>Right</th><th>Strike</th><th>Reason</th><th>P&L%</th><th>P&L $</th></tr>
    ${todayTrades.map((t) => `<tr><td>${(t.ts || '').slice(11, 16)}</td><td>${t.symbol}</td><td>${t.right}</td><td>${t.strike}</td><td>${t.reason_final}</td><td class="${t.isWin ? 'pos' : 'neg'}">${t.pnlPctApprox_final >= 0 ? '+' : ''}${t.pnlPctApprox_final.toFixed(1)}%</td><td class="${t.dollarPnl_final >= 0 ? 'pos' : 'neg'}">${t.dollarPnl_final >= 0 ? '+' : '-'}$${Math.abs(t.dollarPnl_final).toFixed(2)}</td></tr>`).join('')}
    </table>` : '<div class="l">No trades today.</div>'}"""
if old6 not in content:
    print("ERROR: step 6 marker not found — aborting.")
    exit(1)
content = content.replace(old6, new6, 1)

# 7. Add $ column to Daily rollup table
old7 = """  <table><tr><th>Date</th><th>Trades</th><th>Wins</th><th>WR</th><th>Sum P&L%</th></tr>
    ${dailyDates.map((d) => {
      const day = dailyMap[d];
      const wr = day.n ? (100 * day.wins / day.n) : 0;
      const verifiedBadge = day.verified > 0 ? `<span class="badge">${day.verified} verified</span>` : '';
      return `<tr><td>${d}${verifiedBadge}</td><td>${day.n}</td><td>${day.wins}</td><td>${wr.toFixed(0)}%</td><td class="${day.sumPnl >= 0 ? 'pos' : 'neg'}">${day.sumPnl >= 0 ? '+' : ''}${day.sumPnl.toFixed(1)}%</td></tr>`;"""
new7 = """  <table><tr><th>Date</th><th>Trades</th><th>Wins</th><th>WR</th><th>Sum P&L%</th><th>Sum P&L $</th></tr>
    ${dailyDates.map((d) => {
      const day = dailyMap[d];
      const wr = day.n ? (100 * day.wins / day.n) : 0;
      const verifiedBadge = day.verified > 0 ? `<span class="badge">${day.verified} verified</span>` : '';
      return `<tr><td>${d}${verifiedBadge}</td><td>${day.n}</td><td>${day.wins}</td><td>${wr.toFixed(0)}%</td><td class="${day.sumPnl >= 0 ? 'pos' : 'neg'}">${day.sumPnl >= 0 ? '+' : ''}${day.sumPnl.toFixed(1)}%</td><td class="${day.sumDollar >= 0 ? 'pos' : 'neg'}">${day.sumDollar >= 0 ? '+' : '-'}$${Math.abs(day.sumDollar).toFixed(2)}</td></tr>`;"""
if old7 not in content:
    print("ERROR: step 7 marker not found — aborting.")
    exit(1)
content = content.replace(old7, new7, 1)

with open(path, "w") as f:
    f.write(content)
print("All 7 patches applied successfully.")
