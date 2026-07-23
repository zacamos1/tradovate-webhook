path = "server.js"
with open(path, "r") as f:
    content = f.read()

old = "app.get('/health', (req,res) => {"

new = """app.get('/dashboard', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, 'directional_dashboards', 'latest.html');
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send('Dashboard not generated yet -- run push_directional_dashboard.sh first.');
  }
});

app.get('/futures-status', (req, res) => {
  const { execSync } = require('child_process');
  try {
    const evals = execSync('pm2 logs vwap-sender --lines 500 --nostream 2>/dev/null | grep -c \\'"event": "evaluation_done"\\'').toString().trim();
    const trades = execSync('grep -c "position_opened\\\\|position_closed" tradovate_log.jsonl 2>/dev/null || echo 0', { cwd: __dirname }).toString().trim();
    res.type('text/plain').send(`Futures VWAP status\\nEval cycles today: ${evals}\\nTrades: ${trades}`);
  } catch (e) {
    res.status(500).send('Error fetching status: ' + e.message);
  }
});

app.get('/health', (req,res) => {"""

if old not in content:
    print("ERROR: could not find /health route marker — aborting.")
else:
    content = content.replace(old, new, 1)
    with open(path, "w") as f:
        f.write(content)
    print("Patched successfully: added /dashboard and /futures-status routes.")
