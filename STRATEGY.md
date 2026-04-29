# PB Investing — Break & Retest Strategy
**Context file for the trading agent. This is the single source of truth for how the system thinks, what it looks for, and how it should execute.**

---

## What This Strategy Is

A pure price action, rule-based day trading strategy built around one core idea: **levels that have been respected once will be respected again**. Price breaks a key structural level, then returns to test it from the other side. That retest — if confirmed by market bias, VWAP, and EMA — is the entry.

No prediction. No opinion. No gut feel. You wait for the setup to come to you.

**Primary sources:** PBInvesting (@PBInvesting, 110K subscribers) — full 2.5-hour course + supporting videos on break/retest, VWAP/EMA usage, premarket level identification, and 1-minute entry execution.

---

## The Core Setup: Break & Retest

### Step 1 — Identify the Key Level

Before market open, mark these levels on every watchlist symbol:

| Level | Definition | Priority |
|-------|-----------|----------|
| **PMH** | Premarket High (4:00am–9:30am session high) | Highest |
| **PML** | Premarket Low (4:00am–9:30am session low) | Highest |
| **PDH** | Previous Day High (prior RTH session high) | High |
| **PDL** | Previous Day Low (prior RTH session low) | High |
| **VWAP** | Volume Weighted Average Price (daily reset at 9:30am) | Dynamic |
| **8 EMA** | 8-period EMA on the 5-minute chart | Dynamic filter |

PMH and PML are the most important levels — price was accumulating or distributing at those levels before the market opened. When price breaks them in RTH, it is a high-conviction move.

### Step 2 — Wait for the 5m Candle Close Through the Level

**Do NOT enter on the break itself.** Wait for a 5m candle to fully close through the level. This eliminates wicks, fakeouts, and noise. A close through the level is the confirmation signal.

- For SHORT: 5m candle closes *below* PMH, PML, PDH, or PDL
- For LONG: 5m candle closes *above* PMH, PML, PDH, or PDL

### Step 3 — Confirm Market Bias (All 3 Must Agree)

**Gate 1 — Market Direction:**
- SPY AND QQQ must both be on the correct side of their VWAP
- Majority of watchlist symbols must agree with the direction
- If SPY is below VWAP and QQQ is below VWAP → BEARISH bias → only look for SHORTs
- If both are above VWAP → BULLISH bias → only look for LONGs
- Conflicting → NEUTRAL → no trades

**Gate 2 — Per-Symbol VWAP:**
- For SHORT entry: symbol's price must be *below* its own VWAP
- For LONG entry: symbol's price must be *above* its own VWAP
- If price is on the wrong side of VWAP, skip the trade — the institutional bias is against you

**Gate 3 — 8 EMA Filter:**
- For SHORT entry: price must be *below* the 8 EMA on the 5m chart
- For LONG entry: price must be *above* the 8 EMA on the 5m chart
- The 8 EMA acts as dynamic support/resistance — if price is above the EMA it has upward momentum; below = downward momentum
- This filter eliminates counter-trend entries

**Gate 4 — Relative Strength vs SPY:**
- For SHORT: symbol must be showing WEAK relative strength vs SPY (underperforming)
- For LONG: symbol must be showing STRONG relative strength vs SPY (outperforming)
- The best trades are in the names that are moving hardest in the direction of the market

### Step 4 — Wait for the Retest (The Entry Zone)

After the break is confirmed, price will often pull back and retest the broken level from the other side. This is the "flip" — what was support becomes resistance, or vice versa.

**The retest is the entry. Not the break.**

On the 1-minute chart, watch for price to tap back into the broken level within the retest tolerance (~0.2–0.5% of the level price). This is called the **1m tap entry**.

- For SHORT: price taps back up toward the broken level (now acting as resistance) on the 1m
- For LONG: price taps back down toward the broken level (now acting as support) on the 1m

The tap entry is more precise than entering on the 5m close — it gives you a tighter stop and better R:R.

### Step 5 — Entry, Stop, and Target

**Entry:** 1m candle touches/closes at the retest level
**Stop loss:** Just above the structure level (for short) or below it (for long) — based on 5m candle structure
**Profit target:** 2R minimum (2x risk). If targeting 2R, take full or partial at the first measured move
**Breakeven:** Move stop to breakeven after 1R in profit
**Time exit:** If the trade doesn't move within 20 bars, exit — the setup failed

---

## Market Direction Framework

This runs before any symbol is evaluated. If the market is NEUTRAL, no trades fire.

```
BULLISH:  SPY above VWAP AND QQQ above VWAP AND majority of watchlist above VWAP
BEARISH:  SPY below VWAP AND QQQ below VWAP AND majority of watchlist below VWAP
NEUTRAL:  SPY and QQQ disagree, or insufficient alignment
```

The market direction determines which side of the trade you're on for ALL symbols. You never fight the market.

---

## The Full Entry Checklist (Must ALL Pass)

### For a SHORT (PUT) Trade:
- [ ] Market direction = BEARISH (SPY + QQQ below VWAP)
- [ ] 5m candle closed BELOW PMH, PML, PDH, or PDL
- [ ] Symbol price is BELOW its own VWAP
- [ ] Symbol price is BELOW the 8 EMA (5m)
- [ ] Symbol is showing WEAK RS vs SPY
- [ ] Price retests the broken level from below on the 1m chart
- [ ] Session = Regular Market Hours (9:30am–4:00pm ET)

### For a LONG (CALL) Trade:
- [ ] Market direction = BULLISH (SPY + QQQ above VWAP)
- [ ] 5m candle closed ABOVE PMH, PML, PDH, or PDL
- [ ] Symbol price is ABOVE its own VWAP
- [ ] Symbol price is ABOVE the 8 EMA (5m)
- [ ] Symbol is showing STRONG RS vs SPY
- [ ] Price retests the broken level from above on the 1m chart
- [ ] Session = Regular Market Hours (9:30am–4:00pm ET)

---

## Trade Management Rules

| Rule | Detail |
|------|--------|
| **Risk per trade** | 1% of account |
| **Max trades/day** | 4 — after 4 trades, done for the day regardless of P&L |
| **Max open positions** | 3 simultaneously |
| **Stop mode** | Structure close — stop is placed just beyond the 5m structure level |
| **Profit target** | 2R |
| **Breakeven** | Triggered at 1R in profit |
| **Time exit** | Exit after 20 bars if trade hasn't moved |
| **Max capital deployed** | $10,000 per strategy |

---

## Common Setups (From Trade Photo Analysis)

### Most Common Pattern (~80% of trades): Premarket Gap Fail SHORT
1. Stock gaps up significantly in premarket
2. Fails at or near the premarket high at the open
3. Drops below PMH on the 5m
4. VWAP is above price (bearish confirmation)
5. 8 EMA is above price (bearish confirmation)
6. Price retests PMH from below on 1m → SHORT entry

### Second Pattern: PDH/PDL Break & Retest
1. Price breaks above PDH (LONG) or below PDL (SHORT) on the 5m
2. Confirms with VWAP and EMA alignment
3. Pulls back to retest the PDH/PDL level on 1m
4. Entry at the tap

### Third Pattern: LONG on Gap Down Recovery
1. Stock gaps down but finds support at PMH or PDH
2. Market is BULLISH (SPY + QQQ above VWAP)
3. Price reclaims the level and retests it from above
4. RS shows strength vs SPY → LONG entry

---

## Primary Watchlist

SPY, QQQ, IWM, AAPL, TSLA, NVDA, HOOD, GOOGL, PLTR

**SPY and QQQ are always included** — they are the market direction barometer, not just tradeable symbols.

**Best symbols for this setup:** High-volume, liquid names with clean technical levels. NVDA, TSLA, AAPL tend to have the cleanest premarket structure. HOOD moves big on its own.

---

## What NOT to Trade

- During NEUTRAL market direction
- Inside the No-Trade Zone (NTZ): the price range between premarket high and premarket low where chop happens
- Against the market direction (no counter-trend trades)
- When price is on the wrong side of VWAP
- When price is on the wrong side of the 8 EMA
- After 4 trades in a session
- Premarket or after-hours (regular session only)
- Fakeout breaks — wait for the 5m close, not a wick

---

## Timeframe Stack

| Timeframe | Purpose |
|-----------|---------|
| **15m / Daily** | Context — identify overall trend, where price is relative to big levels |
| **5m** | Structure — the primary execution timeframe. Level breaks, VWAP, 8 EMA |
| **1m** | Entry precision — the retest tap. Tighter stop, better R:R than entering on 5m |

The 5m is where you identify the setup. The 1m is where you pull the trigger.

---

## Swing Trade Extension: 9/21 EMA Cross (4H + 1D)

A secondary setup for swing trades. Triggers when momentum shifts on higher timeframes.

**Setup:**
- 9 EMA crosses above 21 EMA on the **4H and/or 1D** chart → LONG bias
- 9 EMA crosses below 21 EMA on the **4H and/or 1D** chart → SHORT bias

**Why it works:** The 9/21 EMA cross on the daily/4H shows sustained momentum — institutions are rotating in or out. Stops are clean and percentage losses are small because you can place the stop at the prior swing low/high.

**Implementation status:** Not yet live in the engine — requires 4H bar aggregation layer.

---

## Algorithm Implementation Summary

### What's Live in the Engine:
- ✅ PMH/PML/PDH/PDL level tracking (resets daily at RTH open)
- ✅ VWAP computation per symbol (resets daily at 9:30am)
- ✅ 8 EMA computation via `emaPeriods: [8]` on 5m bars
- ✅ Market direction from SPY + QQQ vs VWAP + watchlist majority
- ✅ Relative strength filter vs SPY (STRONG/WEAK)
- ✅ 5m break detection (close through level)
- ✅ State machine: IDLE → BROKEN → retest → ENTRY → COOLDOWN
- ✅ 1m tap entry (`onMinuteBar` — fires when 1m range overlaps broken level)
- ✅ EMA8 filter in `evaluateSymbol`: price must be on correct side of 8 EMA
- ✅ Per-symbol VWAP filter in `evaluateSymbol`: price must be on correct side of VWAP
- ✅ Default watchlist seeded: SPY, QQQ, IWM, AAPL, TSLA, NVDA, HOOD, GOOGL, PLTR
- ✅ Default strategy: "PB Break+Retest (EMA8)" auto-seeded on first boot

### What's Pending:
- ⏳ 4H/1D bar aggregation for 9/21 EMA swing setup
- ⏳ IBKR options integration (options contract selection, greeks-aware sizing)
- ⏳ Strategy performance analytics dashboard

---

## Implementation Best Practices

1. **Don't chase the break.** The signal fires when the 5m candle closes through the level. If you're already 2% away from the level, the setup risk/reward is gone. Wait for the next one.

2. **The retest doesn't always happen immediately.** Price can consolidate for several bars before testing back. The `maxRetestBars` setting (default: 3) controls how long the engine waits after a break before invalidating the setup.

3. **VWAP is the single most important filter.** A trade against VWAP will almost always be a loser. If the trade seems perfect but price is on the wrong side of VWAP, skip it.

4. **Relative strength tells you which symbol to trade.** On a bearish day, the weakest symbol (most negative RS vs SPY) is the one to short. That name is under the most distribution pressure.

5. **One trade at a time on the same symbol.** The cooldown period (2 bars after exit) prevents re-entry into the same exhausted setup.

6. **The 8 EMA is not a primary level — it's a confirmation filter.** You don't trade the EMA. You use it to confirm that momentum is on your side. Price above EMA = buyers in control. Below = sellers in control.

7. **Volume matters at the break.** High volume on the break candle = institutions confirming the move. Low volume break = likely fake. (Volume filter: minVolume 1M shares).

8. **Don't trade the first 5 minutes (9:30–9:35am).** The opening is chaotic. Let price find direction and confirm which side of VWAP it's on before taking any signals. The engine is gated to regular market hours but be especially cautious in the first bar.

9. **Stop at 4 trades.** Even on a great day, discipline matters more than P&L. The fourth trade rule keeps you from revenge trading or overtrading a hot market.

10. **The system is rule-based for a reason.** There is no discretionary override. If the checklist doesn't pass, there is no trade. The algorithm is designed to be more patient and disciplined than any human trader.

---

## Reference Videos (PBInvesting YouTube Channel)

- **"The ONLY Trading Guide You'll Ever Need (FULL 2.5+ Hour Course)"** — Full strategy walkthrough, 2h 27m
- **"The ONLY 2 Indicators I use to make $6352/Day trading"** — VWAP + EMA deep dive, 10m
- **"Teaching My Doordash Driver How To Day Trade (Full Guide)"** — End-to-end setup walkthrough, 16m
- **"How I Made 75% Trading Today, While Most Traders Lost..."** — Live trade example, 8m
- **"This 5-Minute Indicator Made Me $9,130 This Week"** — 5m timeframe setup, 10m

Channel: https://www.youtube.com/@PBInvesting
