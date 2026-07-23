path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

old = """async function findContract(symbol) {
  const token = await authenticate();
  const res = await tvGet(
    `/contract/find?name=${encodeURIComponent(symbol)}`, token
  );
  if (!res || !res.id) throw new Error(`Contract not found: ${symbol}`);
  return res;
}"""

new = """async function findContract(symbol) {
  const token = await authenticate();
  // Tradovate's contract/find requires either a specific expiry-qualified
  // local symbol (e.g. "MESU6") or the continuous-contract format ("@MES").
  // Plain root symbols like "MES" return 404 -- confirmed directly against
  // Tradovate's API. Use the continuous format, which we've verified
  // resolves successfully for MES/MNQ/MYM.
  const lookupSymbol = symbol.startsWith('@') ? symbol : `@${symbol}`;
  const res = await tvGet(
    `/contract/find?name=${encodeURIComponent(lookupSymbol)}`, token
  );
  if (!res || !res.id) throw new Error(`Contract not found: ${symbol} (looked up as ${lookupSymbol})`);
  return res;
}"""

if old not in content:
    print("ERROR: findContract marker not found — aborting.")
    exit(1)
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("Patched successfully: findContract() now uses continuous-contract format (@MES/@MNQ/@MYM).")
