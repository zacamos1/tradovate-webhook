path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

# Step 1: add ntfy helper function near the top, after the existing requires
old_requires = "require('dotenv').config();"
new_requires = """require('dotenv').config();
const { execSync } = require('child_process');
const NTFY_TOPIC_ALERTS = process.env.NTFY_TOPIC || '';
function ntfyPush(title, body, priority = 'default', tags = 'chart_with_upwards_trend') {
  if (!NTFY_TOPIC_ALERTS) return;
  try {
    const safe = body.replace(/"/g, "'");
    execSync(
      `curl -s -H "Title: ${title}" -H "Priority: ${priority}" -H "Tags: ${tags}" -d "${safe}" https://ntfy.sh/${NTFY_TOPIC_ALERTS}`,
      { timeout: 10000 }
    );
  } catch (e) { /* non-fatal, don't let notification failures break trading */ }
}"""

if old_requires not in content:
    print("ERROR: could not find dotenv require line — aborting.")
    exit(1)
content = content.replace(old_requires, new_requires, 1)

with open(path, "w") as f:
    f.write(content)

print("Step 1/3 done: ntfy helper added.")
