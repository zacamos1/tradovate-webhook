#!/usr/bin/env python3
"""
patch_futures_route.py

Adds a /futures proxy route to server.js that forwards POST requests
to the futures webhook running on localhost:3001.

This solves the ngrok single-tunnel problem: ParadoxAlgo sends signals
to https://throbbing-finalize-easing.ngrok-free.dev/futures, server.js
receives them on port 3000 and proxies to futures_webhook.js on 3001.

No changes to futures_webhook.js — it keeps running on its own port.
No changes to the /webhook options route — options trading unaffected.

After this patch, update ParadoxAlgo's TradingView alert URL to:
  https://throbbing-finalize-easing.ngrok-free.dev/futures

Usage (trading VPS, ~/ibkr-webhook, market closed):
    python3 patch_futures_route.py
    node --check server.js
    pm2 restart ibkr-webhook
"""
import shutil, subprocess, sys
from datetime import datetime

SERVER = "server.js"

# Inject the /futures proxy route right after the existing /webhook route
ANCHOR = "app.post('/webhook', (req, res) => {"

NEW_ROUTE = """app.post('/futures', (req, res) => {
  // Proxy futures signals to futures_webhook.js on port 3001
  // ParadoxAlgo sends to /futures; we forward to the dedicated futures process
  const http = require('http');
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path: '/webhook',
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(req.headers['x-webhook-secret'] ? { 'x-webhook-secret': req.headers['x-webhook-secret'] } : {}),
      },
    };
    const proxy = http.request(options, (pRes) => {
      let data = '';
      pRes.on('data', chunk => { data += chunk; });
      pRes.on('end', () => {
        try { res.status(pRes.statusCode).json(JSON.parse(data)); }
        catch (e) { res.status(pRes.statusCode).send(data); }
      });
    });
    proxy.on('error', (err) => {
      log('futures proxy error: ' + err.message);
      res.status(502).json({ error: 'futures webhook unavailable', detail: err.message });
    });
    proxy.write(body);
    proxy.end();
  });
});

app.post('/webhook', (req, res) => {"""

def main():
    with open(SERVER) as f:
        src = f.read()

    count = src.count(ANCHOR)
    if count != 1:
        print(f"ABORT: anchor found {count} times (expected 1). No changes made.")
        sys.exit(1)

    backup = f"server.js.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(SERVER, backup)
    print(f"Backup: {backup}")

    src = src.replace(ANCHOR, NEW_ROUTE)
    with open(SERVER, 'w') as f:
        f.write(src)

    result = subprocess.run(['node', '--check', SERVER], capture_output=True, text=True)
    if result.returncode != 0:
        print("SYNTAX FAILED — restoring backup:")
        print(result.stderr)
        shutil.copy2(backup, SERVER)
        sys.exit(1)

    print("Syntax OK.")
    print("\nDone. Steps to activate:")
    print("  1. pm2 restart ibkr-webhook")
    print("  2. Test the proxy:")
    print("     curl -s -X POST https://throbbing-finalize-easing.ngrok-free.dev/futures \\")
    print("       -H 'Content-Type: application/json' \\")
    print("       -d '{\"action\":\"buy\",\"root\":\"MES\",\"qty\":1}'")
    print("  3. Update ParadoxAlgo alert URL to:")
    print("     https://throbbing-finalize-easing.ngrok-free.dev/futures")
    print("\nOptions trading (/webhook) is completely unchanged.")

if __name__ == '__main__':
    main()
