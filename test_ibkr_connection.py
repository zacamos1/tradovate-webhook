from ib_insync import IB

ib = IB()

try:
    print("Connecting...")
    ib.connect("127.0.0.1", 4002, clientId=9999, timeout=15)

    print("Connected:", ib.isConnected())
    print("Server version:", ib.client.serverVersion())
    print("Current IB time:", ib.reqCurrentTime())

except Exception as e:
    print("ERROR:", repr(e))

finally:
    if ib.isConnected():
        ib.disconnect()
