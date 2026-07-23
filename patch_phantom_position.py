path = "tradovate_webhook.js"
with open(path, "r") as f:
    content = f.read()

old = """        // Place the entry order
        const action = direction === 'long' ? 'Buy' : 'Sell';
        const order  = await placeOrder(symbol, action, 1);
        openPosition(symbol, direction, entry_price, atr_at_entry, new Date().toISOString());

        log('signal_accepted', { symbol, direction, signal_type, entry_price, atr_at_entry });
        return send(200, { ok: true, orderId: order.orderId });"""

new = """        // Place the entry order
        const action = direction === 'long' ? 'Buy' : 'Sell';
        const order  = await placeOrder(symbol, action, 1);

        // BUG FIX: only record an open position if the broker actually
        // confirmed the fill. Previously this ran unconditionally, so a
        // rejected order (e.g. the "Access is denied" case) still created
        // internal position-tracking state for a position that was never
        // actually opened -- a phantom position the exit-management logic
        // would then try to manage against a real broker state that didn't
        // exist.
        const orderFailed = !order || !order.orderId || order.failureReason;
        if (orderFailed) {
          log('signal_order_rejected', { symbol, direction, signal_type, entry_price, order });
          return send(200, { ok: false, reason: 'order rejected by broker', order });
        }

        openPosition(symbol, direction, entry_price, atr_at_entry, new Date().toISOString());

        log('signal_accepted', { symbol, direction, signal_type, entry_price, atr_at_entry });
        return send(200, { ok: true, orderId: order.orderId });"""

if old not in content:
    print("ERROR: signal handler marker not found — aborting.")
    exit(1)
content = content.replace(old, new, 1)
with open(path, "w") as f:
    f.write(content)
print("Patched successfully: openPosition() only called on confirmed broker fill, not unconditionally after placeOrder().")
