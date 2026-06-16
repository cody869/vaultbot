# XCFL Vault — Discord Bot

A Discord bot that pulls live league data from your **XCFL Vault** Base44 app and posts it into your server as clean embeds.

## Commands

| Command | What it does |
|---|---|
| `/standings [season]` | Current standings (defaults to the latest season) |
| `/leaders <category> [count]` | Stat leaders — passing, rushing, receiving, or defense |
| `/power` | Latest power rankings, with movement arrows |
| `/tradeblock` | Players and picks currently on the block |
| `/trades [status]` | Recent trade submissions (filter by approved/pending/rejected) |

---

## One-time setup

### 1. Install Node.js
Install Node.js 18 or newer from https://nodejs.org. Verify with `node -v`.

### 2. Get the code ready
Unzip this folder, open a terminal inside it, and run:
```
npm install
```

### 3. Create your Discord bot
1. Go to https://discord.com/developers/applications → **New Application**.
2. Open the **Bot** tab → **Reset Token** → copy the token.
3. Open **General Information** → copy the **Application ID**.
4. Under **Installation** (or **OAuth2 → URL Generator**), select scopes
   `bot` and `applications.commands`, then open the generated URL to invite
   the bot to your server.

### 4. Get your Discord server ID
Enable **Developer Mode** (Discord Settings → Advanced), then right-click your
server icon → **Copy Server ID**.

### 5. Configure environment variables
Copy `.env.example` to `.env` and fill in the values:
```
cp .env.example .env
```
Your `BASE44_APP_ID` is already filled in. You only need to add the three
Discord values.

> **Base44 access:** The bot reads your league entities (standings, stats,
> rankings, trades), which all have public read permissions, so just the
> app ID is enough. If you ever restrict those entities, generate a Base44
> API token and set `BASE44_AUTH_TOKEN` in `.env`.

### 6. Register the slash commands
```
npm run deploy
```
If you set `DISCORD_GUILD_ID`, commands appear instantly in that server.

### 7. Start the bot
```
npm start
```
You should see `✅ XCFL Vault bot online`.

---

## Hosting it 24/7 (recommended)

The bot only responds while it's running. For always-on hosting, **Railway**
is the easiest:

1. Push this folder to a GitHub repo (or use Railway's "Deploy from local").
2. Create a project at https://railway.app → **Deploy from GitHub repo**.
3. In the project **Variables** tab, add the same keys from your `.env`.
4. Railway auto-detects Node and runs `npm start`. Run the deploy step once
   (locally, or as a one-off Railway command) to register the commands.

**Alternatives:** Fly.io and Render have similar free/cheap tiers. Replit works
for testing but tends to sleep unless you pay for "Always On."

---

## Custom emoji (team logos & dev traits)

The bot automatically uses your server's custom emoji. On startup it reads every
custom emoji in your server and matches them by name:

- **Team logos** by abbreviation: `:ari:`, `:cle:`, `:den:`, etc.
- **Dev traits**: `:xfactor_dev:`, `:superstar_dev:`, `:star_dev:`, `:normal_dev:`

No IDs to copy — just make sure those emoji exist in the server the bot is in.
If you add, rename, or replace emoji, restart the bot to refresh the cache. Any
emoji it can't find falls back to a plain unicode symbol, so nothing breaks.

> Team abbreviations come from your Roster/Player data (`team_abbrName`). If an
> emoji name doesn't match the abbreviation (e.g. data says `JAX` but the emoji
> is `:jac:`), tell me and I'll add an alias.

## Customizing

- **Add a command:** add a builder in `deploy-commands.js`, a data function in
  `vault.js`, an embed in `embeds.js`, and a `case` in `index.js`. Re-run
  `npm run deploy`.
- **Change the cycle:** edit `XCFL_CYCLE` in `.env` (currently `M26`).
- **Colors / styling:** tweak `VAULT_COLOR` and the embed builders in `embeds.js`.
