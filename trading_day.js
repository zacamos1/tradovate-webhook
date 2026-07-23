#!/usr/bin/env node
/* trading_day.js — cron gate. Exit 0 if today is a US equity TRADING day,
   exit 1 if it's a weekend or a full-closure market holiday.
   Usage in cron:  ( cd DIR && node trading_day.js && node <feed> ) >> log 2>&1
   The && short-circuits: on a closed day the feed never runs, so no junk rows.

   Full-closure holidays only. Early-close days (Black Friday, Christmas Eve)
   still trade normally, so they are intentionally NOT in this list.

   Optional arg for testing a specific date:  node trading_day.js 2026-07-03

   *** UPDATE ANNUALLY: add the next year's NYSE/Nasdaq holiday dates. ***
*/
'use strict';

// NYSE/Nasdaq full-closure dates, America/New_York.
const HOLIDAYS = new Set([
  // ---- 2026 (verified) ----
  '2026-01-01', // New Year's Day
  '2026-01-19', // Martin Luther King Jr. Day
  '2026-02-16', // Washington's Birthday
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-06-19', // Juneteenth
  '2026-07-03', // Independence Day (observed; Jul 4 is Sat)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
  // ---- 2027 ----
  '2027-01-01', // New Year's Day
  '2027-01-18', // MLK Jr. Day
  '2027-02-15', // Washington's Birthday
  '2027-03-26', // Good Friday (Easter Mar 28)
  '2027-05-31', // Memorial Day
  '2027-06-18', // Juneteenth (observed; Jun 19 is Sat)
  '2027-07-05', // Independence Day (observed; Jul 4 is Sun)
  '2027-09-06', // Labor Day
  '2027-11-25', // Thanksgiving
  '2027-12-24', // Christmas (observed; Dec 25 is Sat)
]);

// resolve "today" in market tz (or a test date passed as arg)
const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
let today, dow;
if (arg) {
  today = arg;
  // weekday of the given date, computed in UTC-noon to avoid tz edge effects
  dow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' })
        .format(new Date(arg + 'T12:00:00Z'));
} else {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  today = `${p.year}-${p.month}-${p.day}`;
  dow = p.weekday;
}

let reason = null;
if (dow === 'Sat' || dow === 'Sun') reason = 'weekend';
else if (HOLIDAYS.has(today)) reason = 'market holiday';

const stamp = new Date().toISOString();
if (reason) {
  console.log(`[trading_day ${stamp}] ${today} (${dow}) — ${reason}: SKIP (market closed)`);
  process.exit(1);
}
console.log(`[trading_day ${stamp}] ${today} (${dow}) — trading day: proceed`);
process.exit(0);
