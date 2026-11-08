// Breakglass backend: an out-of-band incident war room.
//
// Security model (the pitch for Winstead):
// - Every table is PRIVATE. Nobody can subscribe to raw tables.
// - Clients only read data through VIEWS, and every view checks
//   "is the person asking a responder?" first. Strangers get nothing.
// - Every write goes through a reducer, and every reducer checks the
//   caller's identity (ctx.sender). Identity can't be faked by arguments.
// - Phone numbers live in their own table that NO view ever exposes.
//   Only the alert worker sees a phone number, and only inside its queue.
// - The timeline is append-only: there is no reducer to edit or delete it.

import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from 'spacetimedb/server';

// ---------- Allowed values ----------

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'investigating', 'contained', 'resolved'];
const SCOPE_STATUSES = ['exfiltrated', 'encrypted', 'unknown', 'contained'];
const ROLES = ['responder', 'worker'];

// ---------- Tables (all private) ----------

// People allowed into the war room. One row per identity.
const responder = table(
  { name: 'responder' },
  {
    identity: t.identity().primaryKey(),
    name: t.string(),
    role: t.string(), // 'admin' | 'responder' | 'worker' (worker = the SMS bot)
    online: t.bool(),
    joinedAt: t.timestamp(),
  }
);

// Phone numbers, kept apart so no view can ever leak them.
const responderContact = table(
  { name: 'responder_contact' },
  {
    identity: t.identity().primaryKey(),
    phone: t.string(), // E.164 format, e.g. +15551234567
  }
);

// One-time join codes made by the admin. Easier than copying identities around.
const invite = table(
  { name: 'invite' },
  {
    code: t.string().primaryKey(),
    role: t.string(), // 'responder' | 'worker'
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    used: t.bool(),
  }
);

const incident = table(
  { name: 'incident' },
  {
    id: t.u64().primaryKey().autoInc(),
    title: t.string(),
    severity: t.string(),
    status: t.string(),
    affectedSystems: t.string(), // comma-separated, e.g. "Email, Payroll, VPN"
    nextAction: t.string(), // the ONE thing the team should do next (calm UI)
    createdBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

// Append-only log. authorName is "System" for automatic entries.
const timelineEntry = table(
  { name: 'timeline_entry' },
  {
    id: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    authorName: t.string(),
    text: t.string(),
    createdAt: t.timestamp(),
  }
);

// What data got hit, and what happened to it.
const scopeItem = table(
  { name: 'scope_item' },
  {
    id: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    dataName: t.string(), // e.g. "Client contracts share"
    status: t.string(), // exfiltrated | encrypted | unknown | contained
    notes: t.string(),
    updatedAt: t.timestamp(),
  }
);

const chatMessage = table(
  { name: 'chat_message' },
  {
    id: t.u64().primaryKey().autoInc(),
    incidentId: t.u64().index('btree'),
    sender: t.identity(),
    senderName: t.string(),
    text: t.string(),
    sentAt: t.timestamp(),
  }
);

// Texts waiting to go out. The alert worker reads these and sends them via Photon.
// (Reducers can't call the internet, so we queue here and let the worker send.)
const alertOutbox = table(
  { name: 'alert_outbox' },
  {
    id: t.u64().primaryKey().autoInc(),
    incidentId: t.u64(),
    phone: t.string(),
    message: t.string(),
    createdAt: t.timestamp(),
    sent: t.bool(),
    error: t.string(), // empty if fine
  }
);

const spacetimedb = schema({
  responder,
  responderContact,
  invite,
  incident,
  timelineEntry,
  scopeItem,
  chatMessage,
  alertOutbox,
});
export default spacetimedb;

// ---------- Helpers (not exported) ----------

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// Throws unless the caller is a human responder (admin or responder).
function requireResponder(ctx: Ctx) {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (!me || me.role === 'worker') {
    throw new SenderError('Not authorized: you are not a responder.');
  }
  return me;
}

function requireAdmin(ctx: Ctx) {
  const me = requireResponder(ctx);
  if (me.role !== 'admin') throw new SenderError('Only the admin can do that.');
  return me;
}

function requireWorker(ctx: Ctx) {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (!me || me.role !== 'worker') throw new SenderError('Only the alert worker can do that.');
  return me;
}

function requireOneOf(value: string, allowed: string[], fieldName: string) {
  if (!allowed.includes(value)) {
    throw new SenderError(`${fieldName} must be one of: ${allowed.join(', ')}`);
  }
}

function requireText(value: string, fieldName: string, maxLength: number) {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new SenderError(`${fieldName} can't be empty.`);
  if (trimmed.length > maxLength) throw new SenderError(`${fieldName} is too long (max ${maxLength}).`);
  return trimmed;
}

function requireIncident(ctx: Ctx, incidentId: bigint) {
  const found = ctx.db.incident.id.find(incidentId);
  if (!found) throw new SenderError('Incident not found.');
  return found;
}

function addTimeline(ctx: Ctx, incidentId: bigint, authorName: string, text: string) {
  ctx.db.timelineEntry.insert({
    id: 0n,
    incidentId,
    authorName,
    text,
    createdAt: ctx.timestamp,
  });
}

// Queue one text per human responder who has a phone number.
function queueAlert(ctx: Ctx, incidentId: bigint, message: string) {
  for (const contact of ctx.db.responderContact.iter()) {
    const person = ctx.db.responder.identity.find(contact.identity);
    if (!person || person.role === 'worker') continue;
    ctx.db.alertOutbox.insert({
      id: 0n,
      incidentId,
      phone: contact.phone,
      message,
      createdAt: ctx.timestamp,
      sent: false,
      error: '',
    });
  }
}

// 8-character code without look-alike letters (no 0/O, 1/I/L).
function makeCode(ctx: Ctx) {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += letters[ctx.random.integerInRange(0, letters.length - 1)];
  }
  return code;
}

function severityRank(severity: string) {
  return SEVERITIES.indexOf(severity);
}

// ---------- Lifecycle ----------

export const onConnect = spacetimedb.clientConnected(ctx => {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (me) ctx.db.responder.identity.update({ ...me, online: true });
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (me) ctx.db.responder.identity.update({ ...me, online: false });
});

// ---------- Access control ----------

// The very first person to call this becomes the admin. After that it's locked.
export const claimAdmin = spacetimedb.reducer(
  { name: t.string(), phone: t.string() },
  (ctx, { name, phone }) => {
    for (const _existing of ctx.db.responder.iter()) {
      throw new SenderError('This war room already has an admin.');
    }
    ctx.db.responder.insert({
      identity: ctx.sender,
      name: requireText(name, 'Name', 60),
      role: 'admin',
      online: true,
      joinedAt: ctx.timestamp,
    });
    if (phone.trim() !== '') {
      ctx.db.responderContact.insert({ identity: ctx.sender, phone: phone.trim() });
    }
  }
);

// Admin makes a one-time join code. It shows up in the admin's invite_list view.
export const createInvite = spacetimedb.reducer({ role: t.string() }, (ctx, { role }) => {
  requireAdmin(ctx);
  requireOneOf(role, ROLES, 'Role');
  let code = makeCode(ctx);
  while (ctx.db.invite.code.find(code)) code = makeCode(ctx);
  ctx.db.invite.insert({
    code,
    role,
    createdBy: ctx.sender,
    createdAt: ctx.timestamp,
    used: false,
  });
});

// Anyone with a valid unused code can join. The code then dies.
export const joinWithCode = spacetimedb.reducer(
  { code: t.string(), name: t.string(), phone: t.string() },
  (ctx, { code, name, phone }) => {
    const found = ctx.db.invite.code.find(code.trim().toUpperCase());
    if (!found || found.used) throw new SenderError('That code is invalid or already used.');
    if (ctx.db.responder.identity.find(ctx.sender)) throw new SenderError('You already joined.');

    ctx.db.invite.code.update({ ...found, used: true });
    const cleanName = requireText(name, 'Name', 60);
    ctx.db.responder.insert({
      identity: ctx.sender,
      name: cleanName,
      role: found.role,
      online: true,
      joinedAt: ctx.timestamp,
    });
    if (phone.trim() !== '') {
      ctx.db.responderContact.insert({ identity: ctx.sender, phone: phone.trim() });
    }
  }
);

// Kick someone out (e.g. a laptop that might be compromised).
export const removeResponder = spacetimedb.reducer(
  { identity: t.identity() },
  (ctx, { identity }) => {
    requireAdmin(ctx);
    if (identity.isEqual(ctx.sender)) throw new SenderError("You can't remove yourself.");
    ctx.db.responder.identity.delete(identity);
    ctx.db.responderContact.identity.delete(identity);
  }
);

// Responders can update their own phone number.
export const setMyPhone = spacetimedb.reducer({ phone: t.string() }, (ctx, { phone }) => {
  requireResponder(ctx);
  ctx.db.responderContact.identity.delete(ctx.sender);
  if (phone.trim() !== '') {
    ctx.db.responderContact.insert({ identity: ctx.sender, phone: phone.trim() });
  }
});

// ---------- Incidents ----------

export const openIncident = spacetimedb.reducer(
  { title: t.string(), severity: t.string(), affectedSystems: t.string() },
  (ctx, { title, severity, affectedSystems }) => {
    const me = requireResponder(ctx);
    requireOneOf(severity, SEVERITIES, 'Severity');
    const cleanTitle = requireText(title, 'Title', 120);

    const created = ctx.db.incident.insert({
      id: 0n,
      title: cleanTitle,
      severity,
      status: 'open',
      affectedSystems: affectedSystems.trim(),
      nextAction: 'Isolate affected systems and assign an owner.',
      createdBy: ctx.sender,
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
    });

    addTimeline(ctx, created.id, 'System', `${me.name} opened the incident (${severity}).`);
    queueAlert(
      ctx,
      created.id,
      `BREAKGLASS: ${severity.toUpperCase()} incident opened: "${cleanTitle}". Do not use company email or Slack. Join the war room now.`
    );
  }
);

export const setIncidentStatus = spacetimedb.reducer(
  { incidentId: t.u64(), status: t.string() },
  (ctx, { incidentId, status }) => {
    const me = requireResponder(ctx);
    requireOneOf(status, STATUSES, 'Status');
    const current = requireIncident(ctx, incidentId);
    if (current.status === status) return;

    ctx.db.incident.id.update({ ...current, status, updatedAt: ctx.timestamp });
    addTimeline(ctx, incidentId, 'System', `${me.name} changed status: ${current.status} → ${status}.`);
  }
);

// Raising severity texts everyone. Lowering it just logs.
export const setIncidentSeverity = spacetimedb.reducer(
  { incidentId: t.u64(), severity: t.string() },
  (ctx, { incidentId, severity }) => {
    const me = requireResponder(ctx);
    requireOneOf(severity, SEVERITIES, 'Severity');
    const current = requireIncident(ctx, incidentId);
    if (current.severity === severity) return;

    ctx.db.incident.id.update({ ...current, severity, updatedAt: ctx.timestamp });
    addTimeline(ctx, incidentId, 'System', `${me.name} changed severity: ${current.severity} → ${severity}.`);

    if (severityRank(severity) > severityRank(current.severity)) {
      queueAlert(
        ctx,
        incidentId,
        `BREAKGLASS: "${current.title}" ESCALATED to ${severity.toUpperCase()}. Check the war room now.`
      );
    }
  }
);

export const setAffectedSystems = spacetimedb.reducer(
  { incidentId: t.u64(), affectedSystems: t.string() },
  (ctx, { incidentId, affectedSystems }) => {
    const me = requireResponder(ctx);
    const current = requireIncident(ctx, incidentId);
    ctx.db.incident.id.update({ ...current, affectedSystems: affectedSystems.trim(), updatedAt: ctx.timestamp });
    addTimeline(ctx, incidentId, 'System', `${me.name} set affected systems: ${affectedSystems.trim() || '(none)'}.`);
  }
);

export const setNextAction = spacetimedb.reducer(
  { incidentId: t.u64(), nextAction: t.string() },
  (ctx, { incidentId, nextAction }) => {
    const me = requireResponder(ctx);
    const current = requireIncident(ctx, incidentId);
    const clean = requireText(nextAction, 'Next action', 200);
    ctx.db.incident.id.update({ ...current, nextAction: clean, updatedAt: ctx.timestamp });
    addTimeline(ctx, incidentId, 'System', `${me.name} set next action: ${clean}`);
  }
);

// ---------- Timeline (append-only: no edit, no delete) ----------

export const addTimelineEntry = spacetimedb.reducer(
  { incidentId: t.u64(), text: t.string() },
  (ctx, { incidentId, text }) => {
    const me = requireResponder(ctx);
    requireIncident(ctx, incidentId);
    addTimeline(ctx, incidentId, me.name, requireText(text, 'Entry', 1000));
  }
);

// ---------- Data scope ----------

export const addScopeItem = spacetimedb.reducer(
  { incidentId: t.u64(), dataName: t.string(), status: t.string(), notes: t.string() },
  (ctx, { incidentId, dataName, status, notes }) => {
    const me = requireResponder(ctx);
    requireIncident(ctx, incidentId);
    requireOneOf(status, SCOPE_STATUSES, 'Data status');
    const cleanName = requireText(dataName, 'Data name', 120);

    ctx.db.scopeItem.insert({
      id: 0n,
      incidentId,
      dataName: cleanName,
      status,
      notes: notes.trim(),
      updatedAt: ctx.timestamp,
    });
    addTimeline(ctx, incidentId, 'System', `${me.name} added data scope: "${cleanName}" is ${status}.`);
  }
);

export const updateScopeItem = spacetimedb.reducer(
  { scopeItemId: t.u64(), status: t.string(), notes: t.string() },
  (ctx, { scopeItemId, status, notes }) => {
    const me = requireResponder(ctx);
    requireOneOf(status, SCOPE_STATUSES, 'Data status');
    const current = ctx.db.scopeItem.id.find(scopeItemId);
    if (!current) throw new SenderError('Data scope item not found.');

    ctx.db.scopeItem.id.update({ ...current, status, notes: notes.trim(), updatedAt: ctx.timestamp });
    if (current.status !== status) {
      addTimeline(
        ctx,
        current.incidentId,
        'System',
        `${me.name} changed "${current.dataName}": ${current.status} → ${status}.`
      );
    }
  }
);

// ---------- Chat ----------

export const sendChat = spacetimedb.reducer(
  { incidentId: t.u64(), text: t.string() },
  (ctx, { incidentId, text }) => {
    const me = requireResponder(ctx);
    requireIncident(ctx, incidentId);
    ctx.db.chatMessage.insert({
      id: 0n,
      incidentId,
      sender: ctx.sender,
      senderName: me.name,
      text: requireText(text, 'Message', 2000),
      sentAt: ctx.timestamp,
    });
  }
);

// ---------- Alert worker ----------

// The worker calls this after trying to send a text through Photon.
export const markAlertSent = spacetimedb.reducer(
  { alertId: t.u64(), ok: t.bool(), error: t.string() },
  (ctx, { alertId, ok, error }) => {
    requireWorker(ctx);
    const current = ctx.db.alertOutbox.id.find(alertId);
    if (!current) return;
    ctx.db.alertOutbox.id.update({ ...current, sent: ok, error: ok ? '' : error.slice(0, 300) });
    const phoneEnd = current.phone.slice(-4);
    addTimeline(
      ctx,
      current.incidentId,
      'Alert bot',
      ok ? `Text alert delivered to number ending ${phoneEnd}.` : `Text alert FAILED for number ending ${phoneEnd}.`
    );
  }
);

// ---------- Views (the ONLY way clients can read data) ----------

// Who am I? Returns nothing if you haven't joined. The frontend uses this
// to decide whether to show the "join with code" screen.
export const myProfile = spacetimedb.view(
  { name: 'my_profile', public: true },
  t.option(responder.rowType),
  ctx => ctx.db.responder.identity.find(ctx.sender) ?? undefined
);

function isHumanResponder(role: string | undefined) {
  return role === 'admin' || role === 'responder';
}

export const team = spacetimedb.view({ name: 'team', public: true }, t.array(responder.rowType), ctx => {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (!isHumanResponder(me?.role)) return [];
  return [...ctx.db.responder.iter()];
});

export const incidentsFeed = spacetimedb.view(
  { name: 'incidents_feed', public: true },
  t.array(incident.rowType),
  ctx => {
    const me = ctx.db.responder.identity.find(ctx.sender);
    if (!isHumanResponder(me?.role)) return [];
    return [...ctx.db.incident.iter()];
  }
);

export const timelineFeed = spacetimedb.view(
  { name: 'timeline_feed', public: true },
  t.array(timelineEntry.rowType),
  ctx => {
    const me = ctx.db.responder.identity.find(ctx.sender);
    if (!isHumanResponder(me?.role)) return [];
    return [...ctx.db.timelineEntry.iter()];
  }
);

export const scopeFeed = spacetimedb.view({ name: 'scope_feed', public: true }, t.array(scopeItem.rowType), ctx => {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (!isHumanResponder(me?.role)) return [];
  return [...ctx.db.scopeItem.iter()];
});

export const chatFeed = spacetimedb.view(
  { name: 'chat_feed', public: true },
  t.array(chatMessage.rowType),
  ctx => {
    const me = ctx.db.responder.identity.find(ctx.sender);
    if (!isHumanResponder(me?.role)) return [];
    return [...ctx.db.chatMessage.iter()];
  }
);

// Admin only: codes they can hand out.
export const inviteList = spacetimedb.view({ name: 'invite_list', public: true }, t.array(invite.rowType), ctx => {
  const me = ctx.db.responder.identity.find(ctx.sender);
  if (me?.role !== 'admin') return [];
  return [...ctx.db.invite.iter()];
});

// Worker only: texts waiting to be sent. The one place phone numbers appear.
export const alertQueue = spacetimedb.view(
  { name: 'alert_queue', public: true },
  t.array(alertOutbox.rowType),
  ctx => {
    const me = ctx.db.responder.identity.find(ctx.sender);
    if (me?.role !== 'worker') return [];
    return [...ctx.db.alertOutbox.iter()].filter(row => !row.sent && row.error === '');
  }
);
