# Breakglass backend

Out-of-band incident war room. Two parts:

- `spacetimedb/` — the whole backend (data, auth, live sync). SpacetimeDB TypeScript module.
- `alert-worker/` — tiny Node program that texts responders through Photon.

Tested end to end on SpacetimeDB 2.14.1: admin claim, invites, incidents, escalation, scope, chat, stranger lockout, and the worker sending + marking alerts.

## Run it locally

```bash
# 1. Start SpacetimeDB (leave running)
spacetime start

# 2. Publish the module
cd spacetimedb && npm install && cd ..
spacetime publish breakglass --server local --module-path spacetimedb --yes

# 3. Become admin, make a worker invite
spacetime call breakglass --server local claim_admin '"Prakhya"' '"+1YOURNUMBER"'
spacetime call breakglass --server local create_invite '"worker"'
spacetime sql  breakglass --server local "SELECT * FROM invite_list"

# 4. Start the worker (DRY_RUN prints texts instead of sending)
cd alert-worker && npm install
DRY_RUN=1 WORKER_INVITE_CODE=XXXXXXXX npm start

# Real texts:
PHOTON_ADDRESS=host:port IMESSAGE_TOKEN=... APP_URL=https://ransomwhere.xyz WORKER_INVITE_CODE=XXXXXXXX npm start
```

After the first run the worker saves `.worker-token`, so you don't need the code again. Don't commit that file.

After any change to `spacetimedb/src/index.ts`: republish, then regenerate bindings:

```bash
spacetime generate --lang typescript --out-dir alert-worker/src/module_bindings --module-path spacetimedb
```

Then regenerate the web app's bindings too: `cd code && npm run generate`.

## Web app (`code/`)

```bash
cd code && npm install
npm run dev          # http://localhost:5173, talks to ws://localhost:3000 / "breakglass"
```

To point it somewhere else, copy `code/.env.example` to `code/.env` and set `VITE_SPACETIME_URI` and `VITE_DB_NAME`. `npm run build` puts a static site in `code/dist/` that you can host anywhere.

## Security model (say this to Winstead)

- **All tables are private.** Clients can't subscribe to raw tables at all.
- **Reads only through views**, and every view returns nothing unless you're a responder.
- **Every reducer checks `ctx.sender`**, which can't be faked by arguments.
- **Joining needs a one-time invite code** from the admin. Admin can remove a responder instantly.
- **Phone numbers are never exposed** to any responder. Only the worker sees them, inside its queue.
- **Timeline is append-only.** No reducer can edit or delete entries, and every change auto-logs.

## What the frontend subscribes to

```
SELECT * FROM my_profile      -- empty = show "join with code" screen
SELECT * FROM team
SELECT * FROM incidents_feed
SELECT * FROM timeline_feed
SELECT * FROM scope_feed
SELECT * FROM chat_feed
SELECT * FROM invite_list     -- admin only
```

## Reducers

| Reducer | Who | What |
|---|---|---|
| `claimAdmin(name, phone)` | first caller only | becomes admin |
| `createInvite(role)` | admin | `responder` or `worker` code |
| `joinWithCode(code, name, phone)` | anyone with a code | joins |
| `removeResponder(identity)` | admin | kicks someone |
| `setMyPhone(phone)` | responder | update own number |
| `openIncident(title, severity, affectedSystems)` | responder | opens + texts everyone |
| `setIncidentStatus(incidentId, status)` | responder | open / investigating / contained / resolved |
| `setIncidentSeverity(incidentId, severity)` | responder | raising it texts everyone |
| `setAffectedSystems(incidentId, affectedSystems)` | responder | |
| `setNextAction(incidentId, nextAction)` | responder | the one big "do this next" line |
| `addTimelineEntry(incidentId, text)` | responder | append-only |
| `addScopeItem(incidentId, dataName, status, notes)` | responder | exfiltrated / encrypted / unknown / contained |
| `updateScopeItem(scopeItemId, status, notes)` | responder | |
| `sendChat(incidentId, text)` | responder | |
| `markAlertSent(alertId, ok, error)` | worker | |

Severity: `low`, `medium`, `high`, `critical`.

## Deploying to Vultr

On the VPS: install SpacetimeDB, run `spacetime start --listen-addr 127.0.0.1:3000`, put Caddy in front for HTTPS on your domain, then publish with `--server https://your-domain`. The worker and frontend connect with `wss://your-domain`.
