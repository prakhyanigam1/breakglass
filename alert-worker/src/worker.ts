// Breakglass alert worker.
//
// Why this exists: SpacetimeDB reducers can't talk to the internet, so the
// database puts texts in a queue (the alert_queue view). This little program
// watches that queue live, sends each text through Photon (iMessage, falls
// back to SMS), then tells the database "sent" or "failed".
//
// First run: set WORKER_INVITE_CODE to a 'worker' invite from the admin.
// The worker saves its login token to .worker-token so later runs don't need the code.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createGrpcClient } from '@photon-ai/advanced-imessage';
import { DbConnection } from './module_bindings/index.ts';

// ---------- Settings (from environment variables) ----------

const SPACETIME_URI = process.env.SPACETIME_URI ?? 'ws://localhost:3000';
const DB_NAME = process.env.DB_NAME ?? 'breakglass';
const WORKER_INVITE_CODE = process.env.WORKER_INVITE_CODE ?? '';
const APP_URL = process.env.APP_URL ?? ''; // e.g. https://ransomwhere.xyz
const PHOTON_ADDRESS = process.env.PHOTON_ADDRESS ?? ''; // host:port, no https://
const IMESSAGE_TOKEN = process.env.IMESSAGE_TOKEN ?? '';
// DRY_RUN=1 prints texts instead of sending them. Handy for testing without Photon.
const DRY_RUN = process.env.DRY_RUN === '1';
const TOKEN_FILE = '.worker-token';

if (!DRY_RUN && (!PHOTON_ADDRESS || !IMESSAGE_TOKEN)) {
  console.error('Set PHOTON_ADDRESS and IMESSAGE_TOKEN, or run with DRY_RUN=1.');
  process.exit(1);
}

const photon = DRY_RUN ? null : createGrpcClient({ address: PHOTON_ADDRESS, token: IMESSAGE_TOKEN });

// ---------- Sending one text ----------

async function sendText(phone: string, text: string) {
  if (!photon) {
    console.log(`[DRY RUN] to ${phone}: ${text}`);
    return;
  }
  // Photon needs a chat id, not a raw phone number, so we look up the chat first.
  const { chat } = await photon.chats.create([phone]);
  await photon.messages.sendText(chat.guid, text);
}

// ---------- Connecting to SpacetimeDB ----------

const savedToken = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8').trim() : undefined;
const inFlight = new Set<bigint>(); // alert ids we're already sending, so we never double-text
let joinAttempted = false;

async function handleAlert(conn: DbConnection, alert: { id: bigint; phone: string; message: string }) {
  if (inFlight.has(alert.id)) return;
  inFlight.add(alert.id);

  const fullMessage = APP_URL ? `${alert.message} ${APP_URL}` : alert.message;
  try {
    await sendText(alert.phone, fullMessage);
    await conn.reducers.markAlertSent({ alertId: alert.id, ok: true, error: '' });
    console.log(`Sent alert ${alert.id} to number ending ${alert.phone.slice(-4)}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Alert ${alert.id} failed: ${reason}`);
    await conn.reducers.markAlertSent({ alertId: alert.id, ok: false, error: reason }).catch(() => {});
  }
}

DbConnection.builder()
  .withUri(SPACETIME_URI)
  .withDatabaseName(DB_NAME)
  .withToken(savedToken)
  .onConnect((conn, identity, token) => {
    writeFileSync(TOKEN_FILE, token);
    console.log(`Connected as ${identity.toHexString().slice(0, 12)}…`);

    // Any new row in the queue = a text to send.
    conn.db.alertQueue.onInsert((_ctx, alert) => {
      handleAlert(conn, alert);
    });

    conn
      .subscriptionBuilder()
      .onApplied(async () => {
        const me = [...conn.db.myProfile.iter()][0];

        if (!me) {
          if (joinAttempted) return;
          joinAttempted = true;
          if (!WORKER_INVITE_CODE) {
            console.error('Not registered yet. Set WORKER_INVITE_CODE to a worker invite code from the admin.');
            process.exit(1);
          }
          try {
            await conn.reducers.joinWithCode({ code: WORKER_INVITE_CODE, name: 'Alert bot', phone: '' });
            console.log('Joined the war room as the alert worker.');
          } catch (err) {
            console.error('Could not join:', err instanceof Error ? err.message : err);
            process.exit(1);
          }
          return;
        }

        if (me.role !== 'worker') {
          console.error(`This identity has role "${me.role}", not "worker". Delete ${TOKEN_FILE} and use a worker invite.`);
          process.exit(1);
        }

        // Send anything that was already waiting before we connected.
        for (const alert of conn.db.alertQueue.iter()) {
          handleAlert(conn, alert);
        }
        console.log('Watching for alerts…');
      })
      .subscribe(['SELECT * FROM my_profile', 'SELECT * FROM alert_queue']);
  })
  .onConnectError((_ctx, err) => {
    console.error('Could not connect to SpacetimeDB:', err.message);
    process.exit(1);
  })
  .onDisconnect(() => {
    console.error('Disconnected from SpacetimeDB. Exiting so your process manager can restart me.');
    process.exit(1);
  })
  .build();
