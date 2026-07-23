// test_md_access.js
// Purpose: definitively check whether Tradovate's programmatic market-data
// access (md/getChart) works with the current account, or hits the
// CME Non-Display License wall ("Symbol is inaccessible" / UnknownSymbol).
//
// This is READ-ONLY: it authenticates, asks for a small chart data batch,
// prints the result, and exits. It does not place any orders.
//
// Run on the trading VPS: node test_md_access.js
// Requires the same .env vars tradovate_webhook.js already uses:
//   TRADOVATE_CID, TRADOVATE_SECRET, TRADOVATE_USERNAME, TRADOVATE_PASSWORD
// (adjust names below if yours differ slightly)

require('dotenv').config();
const WebSocket = require('ws');
const fetch = global.fetch || require('node-fetch');

const AUTH_URL = 'https://demo.tradovateapi.com/v1/auth/accesstokenrequest';
const MD_WS_URL = 'wss://md-demo.tradovateapi.com/v1/websocket';

const CID = process.env.TRADOVATE_CID;
const SECRET = process.env.TRADOVATE_SECRET;
const USERNAME = process.env.TRADOVATE_USERNAME;
const PASSWORD = process.env.TRADOVATE_PASSWORD;

// Symbol to test with — continuous front-month MES.
// If this fails, we'll also try a couple of alternate formats.
const TEST_SYMBOLS = ['@MES', 'MESU6', 'MES'];

async function authenticate() {
  console.log('Authenticating...');
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: USERNAME,
      password: PASSWORD,
      appId: 'VWAP Reclaim Futures Bot',
      appVersion: '1.0',
      cid: Number(CID),
      sec: SECRET,
    }),
  });
  const data = await res.json();
  if (!data.mdAccessToken) {
    console.error('AUTH FAILED or no mdAccessToken returned:');
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }
  console.log('Auth OK. mdAccessToken acquired. userStatus:', data.userStatus, 'hasMarketData:', data.hasMarketData);
  return data.mdAccessToken;
}

function testSymbol(ws, symbol, reqId) {
  const req = `md/getChart\n${reqId}\n\n${JSON.stringify({
    symbol,
    chartDescription: { underlyingType: 'MinuteBar', elementSize: 5, elementSizeUnit: 'UnderlyingUnits' },
    timeRange: { asMuchAsElements: 10 },
  })}`;
  console.log(`\n--> Requesting chart data for symbol: ${symbol}`);
  ws.send(req);
}

async function main() {
  if (!CID || !SECRET || !USERNAME || !PASSWORD) {
    console.error('Missing one or more required env vars: TRADOVATE_CID, TRADOVATE_SECRET, TRADOVATE_USERNAME, TRADOVATE_PASSWORD');
    process.exit(1);
  }

  const mdAccessToken = await authenticate();

  const ws = new WebSocket(MD_WS_URL);
  let reqId = 1;
  let symbolIndex = 0;
  let authorized = false;

  ws.on('open', () => {
    console.log('WS connected. Waiting for open frame...');
  });

  ws.on('message', (raw) => {
    const msg = raw.toString();
    const frameType = msg[0];
    const body = msg.slice(1);

    if (frameType === 'o') {
      // Open frame -> authorize
      console.log('Received open frame. Authorizing with mdAccessToken...');
      ws.send(`authorize\n${reqId++}\n\n${mdAccessToken}`);
      return;
    }

    if (frameType === 'h') {
      // heartbeat, ignore
      return;
    }

    if (frameType === 'a') {
      let arr;
      try { arr = JSON.parse(body); } catch (e) { console.log('Unparseable frame:', msg); return; }
      for (const item of arr) {
        if (item.s === 200 && !authorized && item.i === 1) {
          authorized = true;
          console.log('Authorized OK. Testing symbols:', TEST_SYMBOLS.join(', '));
          testSymbol(ws, TEST_SYMBOLS[symbolIndex], ++reqId);
          return;
        }
        // Print full response for the getChart request
        console.log('\n=== Response ===');
        console.log(JSON.stringify(item, null, 2));

        if (item.d && item.d.charts) {
          console.log(`\n✅ SUCCESS — got ${item.d.charts.length} bar batch(es) for ${TEST_SYMBOLS[symbolIndex]}`);
          ws.close();
          process.exit(0);
        }
        if (item.d && item.d.e && String(item.d.e).toLowerCase().includes('inaccessible')) {
          console.log(`\n❌ "Symbol is inaccessible" for ${TEST_SYMBOLS[symbolIndex]} — likely the CME Non-Display License wall.`);
        }

        // Move to next symbol to test, or give up
        symbolIndex++;
        if (symbolIndex < TEST_SYMBOLS.length) {
          setTimeout(() => testSymbol(ws, TEST_SYMBOLS[symbolIndex], ++reqId), 500);
        } else {
          console.log('\nAll test symbols exhausted. See results above.');
          ws.close();
          process.exit(0);
        }
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
    process.exit(1);
  });

  setTimeout(() => {
    console.log('\nTimed out waiting for responses after 20s.');
    ws.close();
    process.exit(1);
  }, 20000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});node test_md_access.js
