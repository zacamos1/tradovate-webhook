#!/usr/bin/env python3
import json
import time
from pathlib import Path

LOG = Path("telemetry.jsonl")

def log_event(event_type, **kwargs):
    row = {
        "ts": time.time(),
        "event": event_type,
    }
    row.update(kwargs)

    with LOG.open("a") as f:
        json.dump(row, f)
        f.write("\n")
