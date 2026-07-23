path = "directional_dashboard_html_v2.js"
with open(path, "r") as f:
    content = f.read()

# 1. Add a CT-date helper and use it for "today"
old1 = """const DIR = __dirname;
const today = new Date().toISOString().slice(0, 10);"""
new1 = """const DIR = __dirname;
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
const today = toCTDateStr(new Date().toISOString());"""
if old1 not in content:
    print("ERROR: step 1 marker not found — aborting.")
    exit(1)
content = content.replace(old1, new1, 1)

# 2. Use CT date for each trade's dateStr (affects both today-filtering AND daily rollup grouping)
old2 = """  return {
    ...t,
    dateStr: (t.ts || '').slice(0, 10),
    pnlPctApprox_final: pnl,
    dollarPnl_final: dollarPnl,"""
new2 = """  return {
    ...t,
    dateStr: toCTDateStr(t.ts),
    pnlPctApprox_final: pnl,
    dollarPnl_final: dollarPnl,"""
if old2 not in content:
    print("ERROR: step 2 marker not found — aborting.")
    exit(1)
content = content.replace(old2, new2, 1)

with open(path, "w") as f:
    f.write(content)
print("Patched successfully: today + all dateStr grouping now use CT instead of UTC.")
