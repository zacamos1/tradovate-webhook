path = "vwap_signal_sender.py"
with open(path, "r") as f:
    content = f.read()

# 1. Fix the WEBHOOK_URL default — was silently routing to the wrong executor
old1 = "WEBHOOK_URL  = os.environ.get('VWAP_WEBHOOK_URL', 'http://localhost:3001/webhook')"
new1 = "WEBHOOK_URL  = os.environ.get('VWAP_WEBHOOK_URL', 'http://localhost:3002/signal')"
if old1 not in content:
    print("ERROR: step 1 (WEBHOOK_URL) marker not found — aborting.")
    exit(1)
content = content.replace(old1, new1, 1)

# 2. Add 'direction' to the reclaim (long) signal dict
old2 = """            signals.append({
                'symbol':      symbol,
                'action': 'buy',
                'signal_type': 'reclaim',"""
new2 = """            signals.append({
                'symbol':      symbol,
                'action': 'buy',
                'direction':   'long',
                'signal_type': 'reclaim',"""
if old2 not in content:
    print("ERROR: step 2 (reclaim direction) marker not found — aborting.")
    exit(1)
content = content.replace(old2, new2, 1)

# 3. Add 'direction' to the rejection (short) signal dict
old3 = """            signals.append({
                'symbol':      symbol,
                'action': 'sell',
                'signal_type': 'rejection',"""
new3 = """            signals.append({
                'symbol':      symbol,
                'action': 'sell',
                'direction':   'short',
                'signal_type': 'rejection',"""
if old3 not in content:
    print("ERROR: step 3 (rejection direction) marker not found — aborting.")
    exit(1)
content = content.replace(old3, new3, 1)

with open(path, "w") as f:
    f.write(content)
print("All 3 patches applied: WEBHOOK_URL now defaults to 3002/signal, both signal branches now include 'direction'.")
