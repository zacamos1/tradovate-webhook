'use strict';

require('dotenv').config();
const https = require('https');

const CFG = {
  cid: process.env.TRADOVATE_CID,
  secret: process.env.TRADOVATE_SECRET,
  username: process.env.TRADOVATE_USERNAME,
  password: process.env.TRADOVATE_PASSWORD,
  deviceId: process.env.TRADOVATE_DEVICE_ID,
  account: process.env.TRADOVATE_DEMO_ACCOUNT || 'DEMO7409799',
  baseUrl: 'https://demo.tradovateapi.com/v1',
  appId: 'Tradovate Broker State Check',
  appVersion: '1.0.0'
};

function request(method, endpoint, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(CFG.baseUrl + endpoint);
    const payload = body ? JSON.stringify(body) : '';

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {}

        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(
            new Error(`${method} ${endpoint} HTTP ${res.statusCode}: ${data}`)
          );
        }

        resolve(parsed);
      });
    });

    req.on('error', reject);

    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  try {
    console.log('===== AUTHENTICATING =====');

    const auth = await request(
      'POST',
      '/auth/accesstokenrequest',
      {
        name: CFG.username || CFG.account,
        password: CFG.password,
        appId: CFG.appId,
        appVersion: CFG.appVersion,
        cid: Number(CFG.cid),
        sec: CFG.secret,
        deviceId: CFG.deviceId
      }
    );

    if (!auth.accessToken) {
      throw new Error(`Authentication failed: ${JSON.stringify(auth)}`);
    }

    console.log('Authentication: OK');

    const token = auth.accessToken;

    console.log('\n===== ACCOUNT =====');

    const accounts = await request('GET', '/account/list', null, token);

    const account = accounts.find(
      a => a.name === CFG.account || String(a.id) === String(CFG.account)
    );

    if (!account) {
      throw new Error(`Account not found: ${CFG.account}`);
    }

    console.log(JSON.stringify({
      id: account.id,
      name: account.name,
      active: account.active
    }, null, 2));

    console.log('\n===== BROKER POSITIONS =====');

    const positions = await request('GET', '/position/list', null, token);

    const accountPositions = Array.isArray(positions)
      ? positions.filter(p => Number(p.accountId) === Number(account.id))
      : [];

    if (accountPositions.length === 0) {
      console.log('No broker positions found for this account.');
    } else {
      for (const p of accountPositions) {
        let contract = null;

        if (p.contractId) {
          try {
            contract = await request(
              'GET',
              `/contract/item?id=${encodeURIComponent(p.contractId)}`,
              null,
              token
            );
          } catch {}
        }

        console.log(JSON.stringify({
          positionId: p.id,
          accountId: p.accountId,
          contractId: p.contractId,
          symbol: contract?.name || null,
          netPos: p.netPos,
          netPrice: p.netPrice,
          bought: p.bought,
          sold: p.sold
        }, null, 2));
      }
    }

    console.log('\n===== RECENT ORDERS =====');

    const orders = await request('GET', '/order/list', null, token);

    const recentOrders = Array.isArray(orders)
      ? orders
          .filter(o => Number(o.accountId) === Number(account.id))
          .sort((a, b) => Number(b.id) - Number(a.id))
          .slice(0, 10)
      : [];

    for (const o of recentOrders) {
      console.log(JSON.stringify({
        id: o.id,
        contractId: o.contractId,
        action: o.action,
        orderQty: o.orderQty,
        orderType: o.orderType,
        ordStatus: o.ordStatus,
        filledQty: o.filledQty,
        avgFillPrice: o.avgFillPrice,
        failureReason: o.failureReason
      }, null, 2));
    }

  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  }
})();
