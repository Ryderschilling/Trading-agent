# Render deploy runbook

Service: `Trading-agent` (srv-d67uuifpm1nc738npga0), repo `Ryderschilling/Trading-agent`, Docker, Ohio.

## Why it was never actually live

Three separate reasons, all still true until fixed:

1. **Free instance.** Render spins free instances down on inactivity. A trading
   agent that sleeps drops its market data websocket and places nothing. Free
   instances also cannot mount a persistent disk.
2. **Auto-Deploy is Off.** Pushing to GitHub did nothing.
3. **Last deploy failed 5 months ago** and was never retried.

## One-time setup (in order)

1. **Upgrade the instance** to Starter. Settings has an Upgrade button; the
   disk in step 2 is not available until this is done.
2. **Add a disk.** Name `trading-agent-data`, mount path `/app/data`, 5 GB.
   Without it, every deploy wipes the trade history and the agent re-seeds
   itself from `seed/bootstrap.json` as if it were brand new.
3. **Settings → Build → Branch:** `main`.
4. **Settings → Deploy → Auto-Deploy:** On.
5. **Settings → Health Checks → Health Check Path:** `/api/health`.
6. **Environment:** add the variables below.
7. **Manual Deploy → Deploy latest commit.**

## Environment variables

| Key | Value |
|---|---|
| `PORT` | `10000` |
| `NODE_ENV` | `production` |
| `APCA_API_KEY_ID` | paper key from Alpaca |
| `APCA_API_SECRET_KEY` | paper secret from Alpaca |
| `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` |
| `ALPACA_FEED` | `iex` |
| `AUTH_USERNAME` | `ryder` |
| `AUTH_PASSWORD` | your operator password |
| `INVESTOR_PASSWORD` | the password given to the investor |
| `EXECUTION_ENABLED` | `false` |
| `RISK_PCT_PER_TRADE` | `0.005` |
| `MAX_TRADES_PER_DAY` | `5` |
| `DAILY_LOSS_LIMIT_PCT` | `0.03` |
| `MIN_RISK_PCT` | `0.0015` |

`ALPACA_BASE_URL` is the single switch between paper and live. It stays on
paper until the agent has proven itself on Render for a full session.

## Verifying the deploy

```
curl -s https://<service>.onrender.com/api/health
```

Then in the Render logs, confirm one of these on first boot:

- `[BOOTSTRAP] fresh database seeded: ruleset v11 "B — Chase (v11)" active, 20 watchlist symbols.`
  — expected on the very first deploy with an empty disk.
- No bootstrap line at all — expected on every later deploy, and proof the disk
  is persisting.

If the log says `rulesets table is empty and seed/bootstrap.json is missing`,
the Docker image did not copy `seed/`. That is a build problem, not a data one.

## The double-execution trap

The Mac agent and the Render agent are separate processes pointed at the same
broker account. If both ever have `EXECUTION_ENABLED=true` at once, every signal
is ordered twice. **Exactly one of them may have execution on.** When Render
takes over, stop the Mac agent or set its `EXECUTION_ENABLED=false` and restart it.

## Rolling back a strategy change

Nothing is deleted. To bring back a retired strategy:

```sql
UPDATE rulesets SET active=1 WHERE version=10;
```

Restart the service. The dashboards and the engine both read `active=1`.
