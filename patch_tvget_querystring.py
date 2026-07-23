path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

old = """function tvGet(endpoint, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(CFG.baseUrl + endpoint);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: { Authorization: `Bearer ${token}` },
    };"""

new = """function tvGet(endpoint, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(CFG.baseUrl + endpoint);
    const opts = {
      hostname: url.hostname,
      // BUG FIX: url.pathname alone drops the query string entirely --
      // every GET call through this function (findContract's ?name=...,
      // getquote's ?symbol=...) was silently being sent with NO query
      // parameters at all. Must include url.search to actually send them.
      path:     url.pathname + url.search,
      method:   'GET',
      headers: { Authorization: `Bearer ${token}` },
    };"""

if old not in content:
    print("ERROR: tvGet marker not found — aborting.")
    exit(1)
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("Patched successfully: tvGet() now includes url.search in the request path.")
