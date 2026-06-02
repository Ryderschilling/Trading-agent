# Trading Agent — Launch Checklist

Last updated: 2026-05-27

---

## Status at a glance

| Item                         | Status        | Notes |
|------------------------------|---------------|-------|
| Exit engine (v9)             | ✅ Shipped     | TIME/STOP/TARGET live since 05-22 |
| STRUCTURE_BREAK retired      | ✅ Done        | No new exits since 05-21 |
| Clock-driven EOD flatten     | ✅ Done        | Fix A — 30s interval |
| Stale-session detection      | ✅ Done        | Fix B — red banner in UI |
| Entry-cluster race fix       | ✅ Done        | Fix C — sync reservation |
| Auto-resubscribe on feed drop| ✅ Shipped     | 2026-05-27 — 90s per-symbol check |
| Mac sleep prevention         | ✅ Shipped     | `scripts/start-mac.sh` (caffeinate) |
| Server deployment (Railway)  | ⚠️ Ready       | Docker built, needs Railway setup |
| Real money armed             | 🔴 Not yet    | Needs 2-3 week paper validation |
| Broker-native stop orders    | 🔴 Not working | Software stops only (OK for now) |
| Risk-based position sizing   | ⚠️ Deferred    | Fixed $5k notional, not bug |
| IBKR / options               | 🔴 Not started | Post-launch |

---

## Gate 1 — Fix Mac sleep (TODAY)

**Problem:** Closing the Mac lid suspends Node.js. Timers freeze. Alpaca WebSocket drops.
EOD flatten at 14:59 ET never fires. Positions left open. Data "cuts off in the afternoon."

**Fix A (immediate — already shipped):** Run with `caffeinate`:
```bash
cd Trading-agent
npm run build
./scripts/start-mac.sh
```
This prevents macOS from sleeping the process. Works even with lid closed if plugged in.

**Fix B (real solution — ~1 hour):** Deploy to Railway so the process runs 24/7 on a server.
See "Gate 2 — Railway Deployment" below.

---

## Gate 2 — Railway Deployment

The Dockerfile is production-ready. Steps:

1. **Push to GitHub** (if not already)
   ```bash
   git add -A && git commit -m "Add Railway config, auto-resubscribe, start script"
   git push
   ```

2. **Create Railway project**
   - Go to [railway.app](https://railway.app)
   - New Project → Deploy from GitHub repo → select this repo
   - Railway auto-detects the Dockerfile

3. **Add environment variables** (Settings → Variables):
   ```
   ALPACA_KEY=your_key_here
   ALPACA_SECRET=your_secret_here
   ALPACA_BASE_URL=https://paper-api.alpaca.markets
   ALPACA_FEED=iex
   EXECUTION_ENABLED=true
   PORT=3000
   NODE_ENV=production
   ```

4. **Add a Volume** (Settings → Volumes):
   - Mount path: `/app/data`
   - This persists the SQLite database across restarts

5. **Deploy** — Railway builds and starts the container. ~$5–10/month.

6. **Verify** — open the Railway-assigned URL, confirm the Workspace UI loads, data feed is live.

---

## Gate 3 — Paper validation (2–3 weeks)

Target: at least 20 closed trades on v9, net positive on exit_return_pct.

Current v9 stats (as of 2026-05-27):
- 4 trades, 0 wins, avg -0.52%
- Too small to conclude anything. Keep running.

Checklist:
- [ ] Confirm new closes show `TIME`, `STOP`, or `TARGET` reasons (no `STRUCTURE_BREAK`)
- [ ] Net exit_return_pct across ≥20 v9 trades is positive
- [ ] No stuck/orphan positions (EOD flatten firing every day in logs)
- [ ] SHORT trades — recheck win rate once ≥10 shorts have closed

---

## Gate 4 — Real money

Before flipping `liveArmed: true`:

1. **Pass Gate 3** (paper validation)
2. **Decide position sizing:** fixed $5k notional (current) OR risk-based (1% account).
   - Fixed is simpler and already works. Start there.
   - Risk-based requires wiring `broker/service.ts` to read `riskValue`.
3. **Set `maxOpenPositions`** appropriately for your account size
4. **Confirm broker has capital to cover max exposure** (5 positions × $5k = $25k max)
5. **Flip:** in DB run: `UPDATE broker_config SET mode='live', config_json=json_set(config_json,'$.liveArmed',1) WHERE broker_key='alpaca'`
6. **Watch first 3 days manually** before stepping away

---

## Strategy notes

- Entry window: 9:30–10:30 AM ET only (`isFirstHourNY`)
- Exits: STOP (2R), TARGET (2R), TIME (60 min), EOD (14:59 ET)
- Filters active: market bias, SPY/QQQ alignment, VWAP agreement, relative strength
- SHORT underperforms LONG historically — consider disabling shorts until Gate 3 confirms
- The 9:30–10:00 AM half-hour is historically worst — signals from that window need extra scrutiny

---

## Key commands

```bash
# Start with Mac sleep prevention (use this every day until Railway is deployed)
./scripts/start-mac.sh

# Build before starting
npm run build && ./scripts/start-mac.sh

# Check today's trades
python3 -c "
import sqlite3, json
from datetime import datetime, timezone, date
conn = sqlite3.connect('data/trading-agent.sqlite')
today = date.today().isoformat()
rows = conn.execute('''
  SELECT symbol, dir, entry_ts, end_ts, exit_reason, exit_return_pct
  FROM outcomes WHERE date(entry_ts/1000, \"unixepoch\") = ? AND status != \"SKIPPED\"
  ORDER BY entry_ts
''', (today,)).fetchall()
for r in rows:
    e = datetime.fromtimestamp(r[2]/1000, tz=timezone.utc).strftime('%H:%M')
    x = datetime.fromtimestamp(r[3]/1000, tz=timezone.utc).strftime('%H:%M') if r[3] else 'OPEN'
    print(f'{r[0]} {r[1]} {e}->{x} {r[4]} {r[5]}%')
conn.close()
"

# Railway: view logs
railway logs

# Railway: deploy
railway up
```
