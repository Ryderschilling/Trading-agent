# Would last month's +36% survive the live config?

Replay of the full v11 record (372 signal outcomes, 2026-07-29 to 2026-08-27,
22 sessions) through the settings that are actually deployed on Render.
All figures are sum of per-trade percent returns, 4 bps charged per trade,
which is the same math the investor page uses.

## The headline number is not an account return

`getInvestorStats()` sums `exit_return_pct` across every tracked signal with
equal weight. It never touches position size or account equity. So:

- +36.48% gross is the sum of 372 trade returns.
- +21.60% is that same sum net of 4 bps.
- Only 117 of the 372 ever had a fill (`realized_pnl_usd` populated), totalling
  $802 of realized PnL on the paper account.

The record is signal level, not order level: 16.9 signals per session, against
the 4.6 orders per session that were actually submitted.

## Replay ladder

| Scenario | Trades | Sum of returns | Avg/trade | Win rate | Max DD |
|---|---|---|---|---|---|
| A. Every signal (the headline) | 372 | +21.60% | 0.058% | 40.9% | -27.03% |
| B. + 5 trades/day cap, first come | 110 | +24.34% | 0.221% | 43.6% | -13.21% |
| C. + no shorts above $500/share | 109 | +19.88% | 0.182% | 44.0% | -13.21% |
| D. + PMH/PML unavailable on Render | 78 | +9.16% | 0.117% | 44.9% | -8.86% |

Scenario C is the deployed configuration. Scenario D is C with the one
unresolved Render risk realized.

First come is the correct selection rule: `service.ts:837` counts submitted
orders for the day and skips everything after the cap. There is no ranking.

## On a $2,500 account at $500 per trade

Each position is 20% of equity, so the account return is roughly the sum of
returns times 0.20.

- Scenario C: about +4.0% on the account, roughly $100, max drawdown about 2.6%.
- Scenario D: about +1.8%, roughly $45.

For reference, the same 20% weighting applied to the headline row gives +4.3%.
The 36% and the 21.6% were never account-level numbers at any sizing.

## The part that should slow you down

The 5-per-day subset is not a demonstrated edge.

- t-stat on the 110 net returns is 1.71. Not significant.
- Split by intraday rank: signal 1 of the day averages -0.035%, signal 5
  averages -0.119%, signals 6 and later average -0.010%. Ranks 3 and 4 average
  +0.471% and +0.567% and carry the entire result, on 22 trades each. There is
  no mechanism that makes the third signal of the day good.
- Bootstrap: drawing a random 5 signals per day, 3000 times, gives a median of
  0.00% and a 5th to 95th percentile band of -15.0% to +16.0%. Only 50% of draws
  are positive. The +24.34% first-come result sits above the 95th percentile of
  that band, which means the deployed rule is either capturing something real or
  is at the edge of the noise, and 22 sessions cannot tell the two apart.
- Concentration: the top 3 trades are 8.33 of the 24.34 points, 34% of the total.
- 13 of 22 sessions green.

## Level dependency

| Level | Trades | Sum net |
|---|---|---|
| PMH | 118 | +23.00% |
| PDL | 66 | +20.58% |
| PML | 131 | -10.56% |
| PDH | 57 | -11.42% |

67% of trades used premarket levels, and PMH alone carries the largest block of
the profit. If premarket data does not reach Render the strategy is not merely
smaller, it loses its single best level.

## What this changes

1. Do not quote 36% or 21.6% to Andrew as a return. The honest framing for the
   deployed config on $2,500 is low single digit percent per month, with the
   sample too short to prove it is not zero.
2. Criterion 2 of the paper week (PMH/PML populate) is the highest value check
   in the whole plan. Scenario D is the difference between a small edge and
   nothing.
3. Worth adding: an account-level equity curve that weights each trade by
   notional over equity, so the dashboard stops reporting a number no account
   could earn.
