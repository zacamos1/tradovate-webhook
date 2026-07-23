path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

old = """    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (endpoint.includes('accesstokenrequest')) {
          console.log('[DEBUG] Auth response status:', res.statusCode);
          console.log('[DEBUG] Auth response body:', data);
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });"""

new = """    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    });"""

if old not in content:
    print("ERROR: could not find the debug logging block — aborting.")
    exit(1)
content = content.replace(old, new, 1)

with open(path, "w") as f:
    f.write(content)

print("Debug logging removed cleanly.")
