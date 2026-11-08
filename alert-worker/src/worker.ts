// Breakglass alert worker.
//
// Why this exists: SpacetimeDB reducers can't talk to the internet, so the
// database puts texts in a queue (the alert_queue view). This little program
// watches that queue live, sends each text through Photon Spectrum (iMessage),
// then tells the database "sent" or "failed".
//
// First run: set WORKER_INVITE_CODE to a 'worker' invite from the admin.
// The worker saves its login token to .worker-token so later runs don't need the code.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { DbConnection } from './module_bindings/index.ts';

// ---------- Settings (from environment variables, or alert-worker/.env) ----------

// Real environment variables win over .env (loadEnvFile doesn't overwrite them).
if (existsSync('.env')) process.loadEnvFile('.env');

const SPACETIME_URI = process.env.SPACETIME_URI ?? 'ws://localhost:3000';
const DB_NAME = process.env.DB_NAME ?? 'breakglass';
const WORKER_INVITE_CODE = process.env.WORKER_INVITE_CODE ?? '';
const APP_URL = process.env.APP_URL ?? ''; // e.g. https://ransomwhere.xyz
const SPECTRUM_PROJECT_ID = process.env.SPECTRUM_PROJECT_ID ?? '';
const SPECTRUM_PROJECT_SECRET = process.env.SPECTRUM_PROJECT_SECRET ?? '';
// DRY_RUN=1 prints texts instead of sending them. Handy for testing without Photon.
const DRY_RUN = process.env.DRY_RUN === '1';
const TOKEN_FILE = '.worker-token';

if (!DRY_RUN && (!SPECTRUM_PROJECT_ID || !SPECTRUM_PROJECT_SECRET)) {
  console.error('Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET (in alert-worker/.env), or run with DRY_RUN=1.');
  process.exit(1);
}

const spectrum = DRY_RUN
  ? null
  : await Spectrum({
      projectId: SPECTRUM_PROJECT_ID,
      projectSecret: SPECTRUM_PROJECT_SECRET,
      providers: [imessage.config()],
    });
const im = spectrum ? imessage(spectrum) : null;

// ---------- Sending one text ----------

async function sendText(phone: string, text: string) {
  if (!im) {
    console.log(`[DRY RUN] to ${phone}: ${text}`);
    return;
  }
  // A 1:1 space from the E.164 number (the handle format space.create accepts), then send.
  const space = await im.space.create(phone);
  await space.send(text);
}

// The shared Photon line can only message numbers that texted it first. The SDK
// doesn't document a dedicated error for that, so these codes are our best match;
// the real code is always kept in the error text so this list can be tightened.
const FIRST_CONTACT_CODES = new Set(['chatNotFound', 'addressNotFound', 'newContactThrottled']);

function errorCode(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

function describeSendError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  const detail = code ? `${code}: ${message}` : message;
  return FIRST_CONTACT_CODES.has(code) ? `recipient must text the Breakglass line first (${detail})` : detail;
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
    const reason = describeSendError(err);
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
