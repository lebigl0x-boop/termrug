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

Ownership is decided by the URL: every webhook on the account whose `webhookURL`
is this app's own endpoint is treated as FlowWatch's, whatever created it. That
is what keeps the sync idempotent when the stored id is lost — a storage reset
would otherwise leave the old webhook in place and register a second one, and
Helius bills every delivery, so the account would quietly pay twice for the same
transfers. Extra copies are collapsed into one on the next sync. Webhooks
pointing anywhere else are never read, updated or deleted.

When no enabled rule declares a source wallet, the webhook is deleted rather than
left registered: an unused webhook keeps delivering, and keeps billing.

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

## Storage

FlowWatch picks its storage at startup and logs the choice as `Storage: postgres`
or `Storage: json`.

- **`DATABASE_URL` set** — Postgres is the source of truth. Tables are created on
  first boot (`configs`, `events`, `alerts`, `watched_wallets`, `launches`,
  `app_meta`). Every event and alert is appended as its own row, so history is
  unbounded; the process keeps only the most recent 400 events and 200 alerts in
  memory to serve the live UI. Per-rule counters in the dashboard come from SQL
  aggregates over the full history.
- **`DATABASE_URL` absent** — rules and state are written to `data/*.json`, as
  before. Convenient locally, but the files are the only copy: a container
  without a persistent disk loses them on every redeploy.

Switching between the two is a restart, not a migration — the JSON files are left
untouched when Postgres takes over.

## Deploy on Railway

The detection pipeline needs a long-running process: it holds an open
`parsedTransactionSubscribe` WebSocket to Helius. Serverless platforms
(Vercel, Supabase Edge Functions) cannot keep that socket open, so deploy to a
container platform instead.

1. Push this repository and create a Railway project from it. `railway.json`
   configures the build, the `npm start` command and a `/api/status` healthcheck.
2. Add a **PostgreSQL service** to the same project, then set
   `DATABASE_URL=${{Postgres.DATABASE_URL}}` on the FlowWatch service. Railway's
   filesystem is ephemeral, so without external storage every redeploy wipes the
   rules.
3. Set the service variables: `HELIUS_API_KEY`, and optionally
   `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`.
4. Set `PUBLIC_URL` to the generated domain and `PORT` to the port the domain
   targets. `PUBLIC_URL` falls back to `RAILWAY_PUBLIC_DOMAIN` when unset, but
   that variable is not always present in the container — an incorrect value is
   reported in the UI rather than failing silently.

On boot the service registers its Helius webhook against the stable Railway
domain, so no tunnel and no dashboard configuration are needed.

## Credit usage

The pump.fun subscription is program-wide — `create`, `create_v2`, `buy` and
`buy_v2` for every wallet on the program — and it is the dominant cost of
running FlowWatch. Almost all of it is discarded: a create or buy only matters
when its signer is a wallet that a funding transfer just put under watch.

Two mechanisms keep that under control.

**Server-side account filtering.** The subscription carries
`accounts: [[...watched wallets]]`, one group with OR semantics, so Helius only
delivers transactions touching a wallet currently under watch. Measured on the
live stream: 9.8 messages/second unfiltered, 0.00 with the filter on wallets
that are not trading. The filter is fixed at subscribe time, so a changed wallet
set means a new connection — `applyAccounts()` re-subscribes only when the set
actually differs.

**Opening the subscription only when it is useful.** It opens on a funding match
and closes from the cleanup pass once no watch remains. Watches belonging to a
paused rule do not count: they could never produce an alert, so they must not
hold the subscription open.

Both matter. Filtering alone would keep an idle connection; gating alone breaks
down when a funding range matches often enough for watch windows to overlap
continuously, which is what a routine exchange withdrawal size will do.

The UI reports the closed state as **Standby** in amber — a deliberate idle
state, not a failure.

The trade-off: when a funding transfer arrives, the subscription needs about a
second to connect or re-subscribe. A wallet that creates its token within that
window would be missed. In practice a launch follows its funding by far more
than a second.

## Parsed Stream payload

A `parsedTransactionNotification` nests the transaction two levels down:

```
params.result.value = {
  transaction:  { signature, slot, blockTime, feePayer, accountKeys, nativeTransfers, … },
  instructions: [ { programId, programName, instructionName, decoded: { args, accounts } } ],
  matchedIndexes: [ … ]
}
```

Two details matter and are easy to get wrong:

- `instructions` hangs off `value`, not off `value.transaction`, and each decoded
  account is `{ name, pubkey, isSigner, isWritable }` under `decoded.accounts`.
- On `create_v2` the instruction signer is the mint keypair, not the launcher.
  The funded wallet is `decoded.args.creator`, which is why the create handler
  prefers it over the `user` account.

## Rule types

A rule runs in one of two modes.

**Exchange funding** is the original chain: an exchange hot wallet funds a fresh
wallet, that wallet launches on pump.fun inside the window, and its dev buy
lands in range. It needs source addresses and is driven by the Helius webhook.

**Bundle fingerprint** recognises a launcher by the amounts its own wallets buy
back with. Those amounts repeat across launches within a few tenths of a
percent, so an ordered list of four windows separates them from noise. Launches
arrive from PumpPortal's free `subscribeNewToken` stream, an optional dev buy
range narrows them to candidates, and each candidate's mint joins the Helius
account filter until its buys resolve. A buy outside its window drops the
candidate at once.

Both modes read ranges in either form: explicit bounds, or a target with a
tolerance in percent or SOL. The second form is what bundle amounts need —
`18.204 ± 0.5%` covers the observed spread, while `18.204` to `18.204` would
demand an exact lamport hit.

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
├── data/                 # JSON persistence, used when DATABASE_URL is unset
├── public/               # Trading-terminal web UI
└── src/
    ├── server.js         # Express API, webhook handler, live detection pipeline
    ├── configStore.js    # Validation, in-memory state and cleanup
    ├── storage.js        # Postgres and JSON storage adapters
    ├── helius.js         # Parsed Stream client and transaction helpers
    ├── pumpPortal.js     # Free pump.fun launch stream for bundle rules
    └── telegram.js       # Telegram HTML notification sender
```

## API and realtime UI

- `POST /webhook/helius` — Helius Enhanced Transaction payloads
- `GET /api/bootstrap` — initial terminal state
- `POST /api/configs`, `PUT /api/configs/:id`, `DELETE /api/configs/:id` — rules
- `ws://host/ws` — instant refresh of tape, active watches, alerts, config changes, and Helius stream status

Data stays in `data/configs.json` and `data/state.json`; no database is required. Keep `.env` private and do not commit API keys or bot tokens.
