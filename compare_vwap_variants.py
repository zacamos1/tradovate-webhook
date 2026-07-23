#!/usr/bin/env python3

import numpy as np
import pandas as pd
from pathlib import Path

# ---------------------------------------------------------------------
# CURRENT DEPLOYED SIGNAL PARAMETERS
# ---------------------------------------------------------------------

MIN_BARS = 9
VOL_MULT = 1.5
MAX_HOLD_BARS = 24          # 24 x 5 minutes = 2 hours

# Backtest friction assumptions, round trip
CONFIG = {
    "MES": {
        "file": "mes_3y.parquet",
        "multiplier": 5.0,
        "commission": 2.20,
        "slippage_points": 0.50,   # 0.25 entry + 0.25 exit
        "arm": 1.00,
        "trail": 0.25,
        "stop_mult": 6.0,
    },
    "MNQ": {
        "file": "mnq_3y.parquet",
        "multiplier": 2.0,
        "commission": 2.20,
        "slippage_points": 1.00,   # conservative round-trip assumption
        "arm": 1.00,
        "trail": 0.75,
        "stop_mult": 7.0,
    },
    "MYM": {
        "file": "mym_3y.parquet",
        "multiplier": 0.50,
        "commission": 2.20,
        "slippage_points": 2.00,   # conservative round-trip assumption
        "arm": 1.00,
        "trail": 0.75,
        "stop_mult": 7.0,
    },
}

# ---------------------------------------------------------------------
# VARIANTS
# ---------------------------------------------------------------------
#
# server_current:
#   VWAP resets at midnight New York.
#   Consecutive counters carry across dates.
#
# pine_current_proxy:
#   VWAP resets at midnight Chicago / CME exchange time.
#   Consecutive counters carry across dates.
#
# et_daily_reset:
#   VWAP and counters reset at midnight New York.
#
# chicago_daily_reset:
#   VWAP and counters reset at midnight Chicago.
#
# This isolates whether the reset differences improve or hurt performance.
# ---------------------------------------------------------------------

VARIANTS = {
    "server_current": {
        "vwap_timezone": "America/New_York",
        "reset_counters": False,
    },
    "pine_current_proxy": {
        "vwap_timezone": "America/Chicago",
        "reset_counters": False,
    },
    "et_daily_reset": {
        "vwap_timezone": "America/New_York",
        "reset_counters": True,
    },
    "chicago_daily_reset": {
        "vwap_timezone": "America/Chicago",
        "reset_counters": True,
    },
}


def rma(series, length):
    return series.ewm(alpha=1.0 / length, adjust=False).mean()


def atr_series(df, length=14):
    previous_close = df["Close"].shift(1)

    tr = pd.concat(
        [
            df["High"] - df["Low"],
            (df["High"] - previous_close).abs(),
            (df["Low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)

    return rma(tr, length)


def make_session_key(index, timezone_name):
    localized = index.tz_convert(timezone_name)
    return pd.Series(localized.date, index=index)


def consecutive_counts(condition, session_key=None):
    """
    Count consecutive True values.

    When session_key is supplied, counting restarts when the session date
    changes. Otherwise the sequence carries across dates.
    """
    condition = condition.fillna(False).astype(bool)

    if session_key is None:
        groups = (condition != condition.shift()).cumsum()
    else:
        changed = (
            (condition != condition.shift())
            | (session_key != session_key.shift())
        )
        groups = changed.cumsum()

    counts = condition.groupby(groups).cumcount() + 1
    return counts.where(condition, 0).astype(int)


def build_features(df, variant):
    out = df.copy().sort_index()

    if out.index.tz is None:
        out.index = out.index.tz_localize("America/New_York")
    else:
        out.index = out.index.tz_convert("America/New_York")

    close = out["Close"].astype(float)
    high = out["High"].astype(float)
    low = out["Low"].astype(float)
    volume = out["Volume"].astype(float)

    session_key = make_session_key(
        out.index,
        variant["vwap_timezone"],
    )

    hlc3 = (high + low + close) / 3.0

    cumulative_pv = (hlc3 * volume).groupby(session_key).cumsum()
    cumulative_volume = volume.groupby(session_key).cumsum()

    out["vwap"] = cumulative_pv / cumulative_volume.replace(0, np.nan)

    # Match server semantics:
    # close equal to VWAP is classified as not above / below side.
    out["above_vwap"] = close > out["vwap"]
    out["below_vwap"] = ~out["above_vwap"]

    counter_session = session_key if variant["reset_counters"] else None

    out["consec_below"] = consecutive_counts(
        out["below_vwap"],
        counter_session,
    )

    out["consec_above"] = consecutive_counts(
        out["above_vwap"],
        counter_session,
    )

    out["reclaim"] = (
        out["above_vwap"]
        & ~out["above_vwap"].shift(1).fillna(False)
    )

    out["rejection"] = (
        ~out["above_vwap"]
        & out["above_vwap"].shift(1).fillna(False)
    )

    out["vol_ma"] = volume.rolling(20).mean()
    out["vol_ratio"] = volume / out["vol_ma"]
    out["atr"] = atr_series(out, 14)

    out["bars_below_prior"] = out["consec_below"].shift(1).fillna(0)
    out["bars_above_prior"] = out["consec_above"].shift(1).fillna(0)

    # Session filter from current server:
    # exclude 23:30 ET through 00:04 ET.
    hhmm = out.index.hour * 100 + out.index.minute
    out["hhmm"] = hhmm
    out["session_ok"] = ~((hhmm >= 2330) | (hhmm < 5))

    return out


def generate_signals(features, symbol, variant_name):
    signals = []

    long_mask = (
        features["session_ok"]
        & features["reclaim"]
        & (features["bars_below_prior"] >= MIN_BARS)
        & (features["vol_ratio"] >= VOL_MULT)
    )

    short_mask = (
        features["session_ok"]
        & features["rejection"]
        & (features["bars_above_prior"] >= MIN_BARS)
        & (features["vol_ratio"] >= VOL_MULT)
    )

    for ts, row in features[long_mask].iterrows():
        signals.append(
            {
                "variant": variant_name,
                "symbol": symbol,
                "signal_ts": ts,
                "direction": "long",
                "entry_price": float(row["Close"]),
                "atr_at_entry": float(row["atr"]),
                "vwap": float(row["vwap"]),
                "bars_away": int(row["bars_below_prior"]),
                "vol_ratio": float(row["vol_ratio"]),
            }
        )

    for ts, row in features[short_mask].iterrows():
        signals.append(
            {
                "variant": variant_name,
                "symbol": symbol,
                "signal_ts": ts,
                "direction": "short",
                "entry_price": float(row["Close"]),
                "atr_at_entry": float(row["atr"]),
                "vwap": float(row["vwap"]),
                "bars_away": int(row["bars_above_prior"]),
                "vol_ratio": float(row["vol_ratio"]),
            }
        )

    return sorted(signals, key=lambda x: x["signal_ts"])


def simulate_trade(signal, bars, cfg):
    ts = signal["signal_ts"]
    entry = signal["entry_price"]
    direction = signal["direction"]
    atr_entry = signal["atr_at_entry"]

    if not np.isfinite(atr_entry) or atr_entry <= 0:
        return None

    arm_points = cfg["arm"]
    trail_points = cfg["trail"]
    stop_distance = cfg["stop_mult"] * atr_entry

    if direction == "long":
        stop_price = entry - stop_distance
    else:
        stop_price = entry + stop_distance

    future = bars.loc[bars.index > ts].head(MAX_HOLD_BARS)

    if future.empty:
        return None

    armed = False
    best_price = entry
    exit_price = float(future.iloc[-1]["Close"])
    exit_reason = "timestop"
    exit_ts = future.index[-1]
    bars_held = len(future)

    for number, (bar_ts, bar) in enumerate(future.iterrows(), start=1):
        high = float(bar["High"])
        low = float(bar["Low"])

        if direction == "long":
            # Conservative same-bar assumption:
            # stop is checked before a possible arm/trail.
            if low <= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_ts = bar_ts
                bars_held = number
                break

            if not armed:
                if high >= entry + arm_points:
                    armed = True
                    best_price = high
            else:
                best_price = max(best_price, high)
                trail_price = best_price - trail_points

                if low <= trail_price:
                    exit_price = trail_price
                    exit_reason = "trail"
                    exit_ts = bar_ts
                    bars_held = number
                    break

        else:
            if high >= stop_price:
                exit_price = stop_price
                exit_reason = "stop"
                exit_ts = bar_ts
                bars_held = number
                break

            if not armed:
                if low <= entry - arm_points:
                    armed = True
                    best_price = low
            else:
                best_price = min(best_price, low)
                trail_price = best_price + trail_points

                if high >= trail_price:
                    exit_price = trail_price
                    exit_reason = "trail"
                    exit_ts = bar_ts
                    bars_held = number
                    break

    if direction == "long":
        gross_points = exit_price - entry
    else:
        gross_points = entry - exit_price

    gross_usd = gross_points * cfg["multiplier"]

    friction_usd = (
        cfg["commission"]
        + cfg["slippage_points"] * cfg["multiplier"]
    )

    net_usd = gross_usd - friction_usd

    return {
        **signal,
        "exit_ts": exit_ts,
        "exit_price": float(exit_price),
        "exit_reason": exit_reason,
        "bars_held": bars_held,
        "armed": armed,
        "gross_points": gross_points,
        "gross_usd": gross_usd,
        "friction_usd": friction_usd,
        "net_usd": net_usd,
    }


def max_drawdown(pnl):
    equity = pnl.cumsum()
    running_peak = equity.cummax()
    drawdown = equity - running_peak
    return float(drawdown.min()) if len(drawdown) else 0.0


def profit_factor(group):
    wins = group.loc[group["net_usd"] > 0, "net_usd"].sum()
    losses = -group.loc[group["net_usd"] < 0, "net_usd"].sum()

    if losses == 0:
        return np.inf if wins > 0 else np.nan

    return wins / losses


def summarize(results):
    rows = []

    for (variant, symbol), group in results.groupby(
        ["variant", "symbol"],
        sort=False,
    ):
        group = group.sort_values("signal_ts")

        rows.append(
            {
                "variant": variant,
                "symbol": symbol,
                "trades": len(group),
                "win_rate_pct": 100 * (group["net_usd"] > 0).mean(),
                "net_usd": group["net_usd"].sum(),
                "avg_trade_usd": group["net_usd"].mean(),
                "profit_factor": profit_factor(group),
                "max_drawdown_usd": max_drawdown(group["net_usd"]),
                "long_trades": int((group["direction"] == "long").sum()),
                "short_trades": int((group["direction"] == "short").sum()),
            }
        )

    summary = pd.DataFrame(rows)

    portfolio_rows = []

    for variant, group in results.groupby("variant", sort=False):
        group = group.sort_values("signal_ts")

        portfolio_rows.append(
            {
                "variant": variant,
                "symbol": "ALL",
                "trades": len(group),
                "win_rate_pct": 100 * (group["net_usd"] > 0).mean(),
                "net_usd": group["net_usd"].sum(),
                "avg_trade_usd": group["net_usd"].mean(),
                "profit_factor": profit_factor(group),
                "max_drawdown_usd": max_drawdown(group["net_usd"]),
                "long_trades": int((group["direction"] == "long").sum()),
                "short_trades": int((group["direction"] == "short").sum()),
            }
        )

    summary = pd.concat(
        [summary, pd.DataFrame(portfolio_rows)],
        ignore_index=True,
    )

    return summary


def signal_overlap(results):
    signal_sets = {}

    for variant, group in results.groupby("variant"):
        signal_sets[variant] = set(
            zip(
                group["symbol"],
                group["signal_ts"].astype(str),
                group["direction"],
            )
        )

    base = signal_sets.get("server_current", set())
    rows = []

    for variant, signals in signal_sets.items():
        shared = base & signals
        only_base = base - signals
        only_variant = signals - base
        union = base | signals

        rows.append(
            {
                "variant_vs_server": variant,
                "server_signals": len(base),
                "variant_signals": len(signals),
                "shared_signals": len(shared),
                "server_only": len(only_base),
                "variant_only": len(only_variant),
                "jaccard_pct": (
                    100 * len(shared) / len(union)
                    if union
                    else 100.0
                ),
            }
        )

    return pd.DataFrame(rows)


def yearly_summary(results):
    out = results.copy()
    out["year"] = out["signal_ts"].dt.year

    return (
        out.groupby(["variant", "symbol", "year"], as_index=False)
        .agg(
            trades=("net_usd", "size"),
            net_usd=("net_usd", "sum"),
            avg_trade_usd=("net_usd", "mean"),
            win_rate_pct=("net_usd", lambda x: 100 * (x > 0).mean()),
        )
    )


def main():
    all_results = []

    for symbol, cfg in CONFIG.items():
        path = Path(cfg["file"])

        if not path.exists():
            raise FileNotFoundError(f"Missing dataset: {path}")

        bars = pd.read_parquet(path).sort_index()

        if bars.index.tz is None:
            bars.index = bars.index.tz_localize("America/New_York")
        else:
            bars.index = bars.index.tz_convert("America/New_York")

        bars = bars[
            ~bars.index.duplicated(keep="last")
        ].copy()

        print(
            f"\nLoaded {symbol}: {len(bars):,} bars "
            f"{bars.index.min()} through {bars.index.max()}"
        )

        for variant_name, variant in VARIANTS.items():
            features = build_features(bars, variant)
            signals = generate_signals(
                features,
                symbol,
                variant_name,
            )

            print(
                f"  {variant_name:22s}: "
                f"{len(signals):5d} signals"
            )

            for signal in signals:
                result = simulate_trade(signal, bars, cfg)

                if result is not None:
                    all_results.append(result)

    results = pd.DataFrame(all_results)

    if results.empty:
        print("No completed trades generated.")
        return

    results["signal_ts"] = pd.to_datetime(results["signal_ts"])
    results["exit_ts"] = pd.to_datetime(results["exit_ts"])

    summary = summarize(results)
    overlap = signal_overlap(results)
    yearly = yearly_summary(results)

    summary = summary.sort_values(
        ["symbol", "net_usd"],
        ascending=[True, False],
    )

    print("\n" + "=" * 125)
    print("VWAP VARIANT PERFORMANCE")
    print("=" * 125)

    print(
        summary.to_string(
            index=False,
            formatters={
                "win_rate_pct": "{:.1f}".format,
                "net_usd": "${:,.0f}".format,
                "avg_trade_usd": "${:,.2f}".format,
                "profit_factor": "{:.2f}".format,
                "max_drawdown_usd": "${:,.0f}".format,
            },
        )
    )

    print("\n" + "=" * 100)
    print("SIGNAL OVERLAP VERSUS CURRENT SERVER")
    print("=" * 100)

    print(
        overlap.to_string(
            index=False,
            formatters={"jaccard_pct": "{:.1f}".format},
        )
    )

    print("\n" + "=" * 100)
    print("ALL-SYMBOL RANKING")
    print("=" * 100)

    ranking = summary[summary["symbol"] == "ALL"].sort_values(
        ["profit_factor", "net_usd"],
        ascending=False,
    )

    print(
        ranking.to_string(
            index=False,
            formatters={
                "win_rate_pct": "{:.1f}".format,
                "net_usd": "${:,.0f}".format,
                "avg_trade_usd": "${:,.2f}".format,
                "profit_factor": "{:.2f}".format,
                "max_drawdown_usd": "${:,.0f}".format,
            },
        )
    )

    results.to_csv(
        "vwap_variant_trade_results.csv",
        index=False,
    )

    summary.to_csv(
        "vwap_variant_summary.csv",
        index=False,
    )

    overlap.to_csv(
        "vwap_variant_signal_overlap.csv",
        index=False,
    )

    yearly.to_csv(
        "vwap_variant_yearly.csv",
        index=False,
    )

    print("\nSaved:")
    print("  vwap_variant_trade_results.csv")
    print("  vwap_variant_summary.csv")
    print("  vwap_variant_signal_overlap.csv")
    print("  vwap_variant_yearly.csv")


if __name__ == "__main__":
    main()
