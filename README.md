# Trading Agent

A real-time trading automation platform built on Node.js + Express + Socket.IO with an Alpaca market data stream, multi-strategy signal engine, and broker execution layer.

## Quick Start

```bash
npm install
cp .env.example .env   # fill in your credentials
npm run dev            # ts-node src/index.ts
```

Dashboard opens at `http://localhost:3000` (or the `PORT` you set).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APCA_API_KEY_ID` | Yes (for live data) | Alpaca API key ID |
| `APCA_API_SECRET_KEY` | Yes (for live data) | Alpaca API secret key |
| `PORT` | No (default: 3000) | HTTP server port |
| `ALPACA_FEED` | No (default: iex) | `iex` (free), `sip` (paid), `delayed_sip` |
| `TIMEFRAME_MINUTES` | No (default: 5) | Bar aggregation timeframe in minutes |
| `AGENT_SECRET` | No | Bearer token to gate the web UI (see Auth section) |
| `OPENAI_API_KEY` | No | Enables the in-app AI Operator panel |
| `AGENT_OPENAI_API_KEY` | No | Optional override for the AI Operator only |
| `AGENT_OPENAI_MODEL` | No (default: `gpt-4o-mini`) | Model used by the AI Operator |
| `OPENAI_BASE_URL` | No | Optional OpenAI-compatible base URL override |

### AGENT_SECRET — Web UI Auth

Set `AGENT_SECRET` to a long random string to require a login token before accessing the dashboard.

```bash
# Generate a strong secret:
openssl rand -hex 32
```

Add the output to your `.env`:
```
AGENT_SECRET=abc123...your-random-string
```

When `AGENT_SECRET` is set:
- All routes redirect to `/login` unless a valid token is present
- The login page (`/login`) posts the token to `/api/login`
- On success, an `HttpOnly` cookie (`agent_token`) is set for subsequent page loads
- Requests can also authenticate via `Authorization: Bearer <token>` header or `?token=` query param

When `AGENT_SECRET` is empty, the server runs in **dev mode** — all requests are allowed and a warning is logged at startup.

---

## IBKR Client Portal Gateway Setup

The IBKR adapter connects to the [IBKR Client Portal Web API Gateway](https://ibkr.info/article/3710), which runs locally on your machine.

### Steps

1. Download and start the IBKR Client Portal Gateway:
   ```bash
   # After downloading and unzipping the gateway:
   cd clientportal.gw
   sh bin/run.sh root/conf.yaml
   ```

2. Log in via the gateway's local web interface (typically `https://localhost:5000`)

3. In the Trading Agent broker settings, select **IBKR** and configure:
   - **Host**: `localhost` (or wherever the gateway runs)
   - **Port**: `5000` (default)
   - **Account ID**: Your IBKR account number (e.g. `DU1234567`). If left blank, the adapter auto-discovers it.

4. The adapter uses `rejectUnauthorized: false` for HTTPS because the gateway uses a self-signed certificate. This is expected behavior for local gateway connections.

### Notes

- The gateway must remain running while Trading Agent is executing orders
- Paper trading accounts use the same gateway — set the **mode** to `paper` in the broker settings
- Bracket orders are not yet implemented; a warning is logged if `bracketEnabled` is true

---

## Architecture

```
Alpaca WebSocket (1m bars)
  ↓
AlpacaStream → ingestMinuteBar()
  ↓
Aggregate → timeframe bars
  ↓
SignalEngine per enabled strategy
  ↓
Alert → broadcast (Socket.IO) + BrokerExecutionService
  ↓
BrokerAdapter (Alpaca | IBKR) → submitMarketOrder()
  ↓
BrokerOrderRecord → SQLite
```

## AI Operator

The Workspace page now includes an **AI Operator** panel that can:

- Draft or create new strategy rulesets from plain-English prompts
- Update and activate existing rulesets
- Add or remove watchlist symbols
- Queue backtests for created or selected strategies

To enable it, set either `OPENAI_API_KEY` or `AGENT_OPENAI_API_KEY` in `.env` and restart the server.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start with ts-node (development) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
