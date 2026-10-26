# FlowWatch — Solana Exchange Scanner

Monitoring web app for a specific Solana signal chain:

1. An exchange wallet sends a configured amount of SOL to a new wallet.
2. That wallet creates a token on pump.fun inside the configured time window.
3. The same wallet makes a pump.fun dev buy in the configured SOL range.
4. FlowWatch records the match live and sends a Telegram alert.

The app supports independent rules: each rule has its own exchange wallets, **multiple funding ranges**, **multiple dev-buy ranges**, observation window, Telegram chat override, and on/off state. Each rule is selected from the left rail and has its own filtered dashboard, live funnel, active-wallet list, and alert history.

## Requirements

- Node.js 20+
- A Helius API key with **Parsed Streams** access (currently a paid-plan beta feature)
- A Helius Enhanced Transaction Webhook configured for the watched exchange addresses
- Optional: a Telegram bot token and destination chat ID

## Start locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`, create one or more rules, then add the values below to `.env`:

```dotenv
HELIUS_API_KEY=your_helius_key
TELEGRAM_BOT_TOKEN=123456:bot_token
TELEGRAM_CHAT_ID=-1001234567890
PUBLIC_URL=https://your-public-url.example
PORT=3000
```

`TELEGRAM_CHAT_ID` is the fallback delivery chat. A value configured directly in a rule takes priority. The app still logs the alert in the UI if Telegram is intentionally unconfigured or delivery fails.

## Configure Helius

### 1. Webhook endpoint (registered automatically)

FlowWatch manages its own Helius webhook. At startup — and after every rule
create / update / delete — it pushes the `watchAddresses` of all enabled rules to
an **Enhanced Transaction** webhook pointing at `${PUBLIC_URL}/webhook/helius`,
with native SOL `TRANSFER` events included.

It owns exactly one webhook, tracked by the id stored in `data/state.json`. Any
other webhook on the Helius account is never read, updated or deleted, so this is
safe to run alongside other projects.

Two conditions must hold, and both are reported in the UI event feed and in
`webhookStatus` when they don't:

- `PUBLIC_URL` must be reachable from the internet. A `localhost` value skips
  registration entirely — this is the single most common reason the dashboard
  stays empty while the Parsed Stream shows **Live**.
- At least one enabled rule must declare a source wallet.

For local development, expose the port with a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000
```

Copy the generated HTTPS URL into `PUBLIC_URL` and restart. Free quick-tunnel URLs
change on every session; FlowWatch updates the webhook to the new URL on the next
startup.

### 2. Parsed Streams

At startup the backend opens a Helius `parsedTransactionSubscribe` WebSocket subscription with:

- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (pump.fun)
- Instructions: `create`, `create_v2`, `buy`, `buy_v2`
- CPI inclusion and failed-transaction filtering enabled

No manual stream configuration is needed beyond `HELIUS_API_KEY`. If Helius changes its beta WebSocket endpoint, set `PARSED_STREAM_URL` to the full endpoint (including its API-key query parameter) in `.env`.

## Deploy on Railway

The detection pipeline needs a long-running process: it holds an open
`parsedTransactionSubscribe` WebSocket to Helius. Serverless platforms
(Vercel, Supabase Edge Functions) cannot keep that socket open, so deploy to a
container platform instead.

1. Push this repository and create a Railway project from it. `railway.json`
   configures the build, the `npm start` command and a `/api/status` healthcheck.
2. Add a **volume mounted at `/app/data`**. Without it, `configs.json` and
   `state.json` are wiped on every redeploy, because Railway's filesystem is
   ephemeral.
3. Set the service variables: `HELIUS_API_KEY`, and optionally
   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
4. Leave `PUBLIC_URL` and `PORT` unset — Railway injects `PORT`, and `PUBLIC_URL`
   is derived from `RAILWAY_PUBLIC_DOMAIN` automatically.

On boot the service registers its Helius webhook against the stable Railway
domain, so no tunnel and no dashboard configuration are needed.

## Detection details

- A matching funding transfer creates a separate, expiring watched-wallet record for its rule.
- A create / create_v2 instruction from that wallet is associated with the funding record.
- A buy / buy_v2 instruction must originate from the same creator, use the newly created mint, and land in the dev-buy range to fire an alert.
- The buy amount prefers the actual largest outbound native transfer from the buyer in the parsed transaction. If Helius does not include transfers, it falls back to the decoded quote/SOL instruction argument.
- Each watched funding record emits at most one alert. Expired watches and pending launches are pruned automatically every 30 seconds.

## Telegram alert

Telegram messages use HTML formatting and include the rule name, funded wallet, funding amount and transaction, token name/symbol/mint, dev-buy amount, funding elapsed time, and pump.fun/Solscan links.

## Project structure

```text
solana-exchange-scanner/
├── data/                 # Runtime JSON persistence (rules, watches, feed, alerts)
├── public/               # Trading-terminal web UI
└── src/
    ├── server.js         # Express API, webhook handler, live detection pipeline
    ├── configStore.js    # Validated JSON persistence and cleanup state
    ├── helius.js         # Parsed Stream client and transaction helpers
    └── telegram.js       # Telegram HTML notification sender
```

## API and realtime UI

- `POST /webhook/helius` — Helius Enhanced Transaction payloads
- `GET /api/bootstrap` — initial terminal state
- `POST /api/configs`, `PUT /api/configs/:id`, `DELETE /api/configs/:id` — rules
- `ws://host/ws` — instant refresh of tape, active watches, alerts, config changes, and Helius stream status

Data stays in `data/configs.json` and `data/state.json`; no database is required. Keep `.env` private and do not commit API keys or bot tokens.
