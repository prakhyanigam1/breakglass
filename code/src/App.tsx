import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import type { Timestamp } from 'spacetimedb';
import { tables, reducers } from './module_bindings';
import type { Incident } from './module_bindings/types';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'investigating', 'contained', 'resolved'];
const SCOPE_STATUSES = ['exfiltrated', 'encrypted', 'unknown', 'contained'];

// ---------- Small helpers ----------

function ms(ts: Timestamp) {
  return Number(ts.microsSinceUnixEpoch / 1000n);
}
function timeOf(ts: Timestamp) {
  return new Date(ms(ts)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dateTimeOf(ts: Timestamp) {
  return new Date(ms(ts)).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function errorText(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^.*SenderError:\s*/, '');
}

// Runs a reducer call and shows any error in a toast instead of crashing.
function useAction() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  async function run(fn: () => Promise<void>) {
    try {
      await fn();
      return true;
    } catch (err) {
      setToast(errorText(err));
      return false;
    }
  }
  return { run, toast, clearToast: () => setToast(null) };
}

type Run = ReturnType<typeof useAction>['run'];

// ---------- App ----------

export default function App() {
  const conn = useSpacetimeDB();
  const [profileRows, profileReady] = useTable(tables.myProfile);
  const me = profileRows[0];
  const action = useAction();

  let body: ReactNode;
  if (conn.connectionError) {
    body = (
      <Center>
        <h1 className="brand">Breakglass</h1>
        <p className="muted">Can't reach the war room server. Check that SpacetimeDB is running and the address is right.</p>
        <code className="small">{import.meta.env.VITE_SPACETIME_URI ?? 'ws://localhost:3000'}</code>
      </Center>
    );
  } else if (!conn.isActive || !profileReady) {
    body = (
      <Center>
        <h1 className="brand">Breakglass</h1>
        <p className="muted">Connecting…</p>
      </Center>
    );
  } else if (!me) {
    body = <JoinScreen run={action.run} />;
  } else if (me.role === 'worker') {
    body = (
      <Center>
        <p className="muted">This browser is signed in as the alert bot. Use a different browser to join as a person.</p>
      </Center>
    );
  } else {
    body = <WarRoom meName={me.name} isAdmin={me.role === 'admin'} run={action.run} />;
  }

  return (
    <>
      {body}
      {action.toast && (
        <div className="toast" role="alert" onClick={action.clearToast}>
          {action.toast}
        </div>
      )}
    </>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div className="center">
      <div className="center-card">{children}</div>
    </div>
  );
}

// ---------- Join / first-time setup ----------

function JoinScreen({ run }: { run: Run }) {
  const joinWithCode = useReducer(reducers.joinWithCode);
  const claimAdmin = useReducer(reducers.claimAdmin);
  const [mode, setMode] = useState<'join' | 'setup'>('join');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await run(() =>
      mode === 'join'
        ? joinWithCode({ code: code.trim(), name: name.trim(), phone: phone.trim() })
        : claimAdmin({ name: name.trim(), phone: phone.trim() })
    );
    setBusy(false);
  }

  return (
    <Center>
      <h1 className="brand">Breakglass</h1>
      <p className="muted">
        {mode === 'join'
          ? 'Out-of-band war room. Enter the one-time code your admin gave you.'
          : 'First-time setup. The first person to do this becomes the admin.'}
      </p>
      <form className="stack" onSubmit={submit}>
        {mode === 'join' && (
          <label>
            Invite code
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXXXXX"
              autoFocus
              required
              className="mono"
            />
          </label>
        )}
        <label>
          Your name
          <input value={name} onChange={e => setName(e.target.value)} required maxLength={60} autoFocus={mode === 'setup'} />
        </label>
        <label>
          Phone for alerts <span className="muted">(optional, never shown to others)</span>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" type="tel" />
        </label>
        <button className="primary" disabled={busy}>
          {mode === 'join' ? 'Join the war room' : 'Become admin'}
        </button>
      </form>
      <button className="link" onClick={() => setMode(mode === 'join' ? 'setup' : 'join')}>
        {mode === 'join' ? 'Setting this up for the first time?' : 'I have an invite code'}
      </button>
    </Center>
  );
}

// ---------- Main war room ----------

function WarRoom({ meName, isAdmin, run }: { meName: string; isAdmin: boolean; run: Run }) {
  const [incidents] = useTable(tables.incidentsFeed);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [panel, setPanel] = useState<'incident' | 'new' | 'team'>('incident');

  const sorted = useMemo(() => {
    const active = (i: Incident) => (i.status === 'resolved' ? 1 : 0);
    return [...incidents].sort((a, b) => active(a) - active(b) || ms(b.updatedAt) - ms(a.updatedAt));
  }, [incidents]);

  const selected = sorted.find(i => i.id === selectedId) ?? sorted.find(i => i.status !== 'resolved') ?? sorted[0];

  function pick(id: bigint) {
    setSelectedId(id);
    setPanel('incident');
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand small-brand">Breakglass</span>
          <span className="muted small">{meName}{isAdmin ? ' · admin' : ''}</span>
        </div>
        <button className="primary block" onClick={() => setPanel('new')}>
          + Open incident
        </button>
        <nav className="incident-list">
          {sorted.length === 0 && <p className="muted small pad">No incidents. Quiet is good.</p>}
          {sorted.map(i => (
            <button
              key={i.id.toString()}
              className={`incident-item ${panel === 'incident' && selected?.id === i.id ? 'active' : ''} ${i.status === 'resolved' ? 'resolved' : ''}`}
              onClick={() => pick(i.id)}
            >
              <span className={`sev-dot sev-${i.severity}`} />
              <span className="incident-item-text">
                <span className="incident-item-title">{i.title}</span>
                <span className="muted small">
                  {i.status} · {dateTimeOf(i.createdAt)}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <button className={`ghost block ${panel === 'team' ? 'active' : ''}`} onClick={() => setPanel('team')}>
          Team{isAdmin ? ' & invites' : ''}
        </button>
      </aside>

      <main className="main">
        {panel === 'new' && <NewIncident run={run} onCreated={() => { setSelectedId(null); setPanel('incident'); }} />}
        {panel === 'team' && <TeamPanel isAdmin={isAdmin} run={run} />}
        {panel === 'incident' &&
          (selected ? (
            <IncidentView key={selected.id.toString()} incident={selected} run={run} />
          ) : (
            <div className="empty">
              <h2>All clear</h2>
              <p className="muted">When something goes wrong, open an incident. Everyone with a phone on file gets a text.</p>
            </div>
          ))}
      </main>
    </div>
  );
}

// ---------- New incident ----------

function NewIncident({ run, onCreated }: { run: Run; onCreated: () => void }) {
  const openIncident = useReducer(reducers.openIncident);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('high');
  const [systems, setSystems] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await run(() => openIncident({ title: title.trim(), severity, affectedSystems: systems.trim() }));
    setBusy(false);
    if (ok) onCreated();
  }

  return (
    <section className="card narrow">
      <h2>Open an incident</h2>
      <p className="muted">This texts every responder right away.</p>
      <form className="stack" onSubmit={submit}>
        <label>
          What's happening?
          <input value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} autoFocus placeholder="Ransom note on file server" />
        </label>
        <label>
          Severity
          <div className="seg">
            {SEVERITIES.map(s => (
              <button type="button" key={s} className={`seg-btn ${severity === s ? `on sev-bg-${s}` : ''}`} onClick={() => setSeverity(s)}>
                {s}
              </button>
            ))}
          </div>
        </label>
        <label>
          Affected systems <span className="muted">(comma-separated)</span>
          <input value={systems} onChange={e => setSystems(e.target.value)} placeholder="Email, Payroll, VPN" />
        </label>
        <button className="danger" disabled={busy}>Open incident and alert team</button>
      </form>
    </section>
  );
}

// ---------- One incident ----------

function IncidentView({ incident, run }: { incident: Incident; run: Run }) {
  const setStatus = useReducer(reducers.setIncidentStatus);
  const setSeverity = useReducer(reducers.setIncidentSeverity);
  const setNextAction = useReducer(reducers.setNextAction);
  const setAffected = useReducer(reducers.setAffectedSystems);
  const id = incident.id;

  return (
    <div className="incident">
      <header className="incident-head">
        <div>
          <span className={`badge sev-bg-${incident.severity}`}>{incident.severity}</span>
          <h1>{incident.title}</h1>
          <p className="muted small">Opened {dateTimeOf(incident.createdAt)} · updated {timeOf(incident.updatedAt)}</p>
        </div>
        <div className="controls">
          <label className="inline">
            Status
            <select value={incident.status} onChange={e => run(() => setStatus({ incidentId: id, status: e.target.value }))}>
              {STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className="inline">
            Severity
            <select
              value={incident.severity}
              onChange={e => {
                const next = e.target.value;
                const raising = SEVERITIES.indexOf(next) > SEVERITIES.indexOf(incident.severity);
                if (raising && !confirm(`Raise to ${next.toUpperCase()}? This texts everyone.`)) return;
                run(() => setSeverity({ incidentId: id, severity: next }));
              }}
            >
              {SEVERITIES.map(s => <option key={s}>{s}</option>)}
            </select>
          </label>
        </div>
      </header>

      <EditableBlock
        className="next-action"
        label="Do this next"
        value={incident.nextAction}
        maxLength={200}
        onSave={v => run(() => setNextAction({ incidentId: id, nextAction: v }))}
      />

      <EditableBlock
        className="systems"
        label="Affected systems"
        value={incident.affectedSystems}
        allowEmpty
        maxLength={500}
        render={v =>
          v ? (
            <div className="chips">{v.split(',').map(s => s.trim()).filter(Boolean).map(s => <span className="chip" key={s}>{s}</span>)}</div>
          ) : (
            <span className="muted">None listed</span>
          )
        }
        onSave={v => run(() => setAffected({ incidentId: id, affectedSystems: v }))}
      />

      <ScopePanel incidentId={id} run={run} />

      <div className="two-col">
        <Timeline incidentId={id} run={run} />
        <Chat incidentId={id} run={run} />
      </div>
    </div>
  );
}

function EditableBlock(props: {
  label: string;
  value: string;
  className?: string;
  allowEmpty?: boolean;
  maxLength: number;
  render?: (v: string) => ReactNode;
  onSave: (v: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (await props.onSave(draft.trim())) setEditing(false);
  }

  return (
    <section className={`card ${props.className ?? ''}`}>
      <div className="card-head">
        <h3>{props.label}</h3>
        {!editing && (
          <button className="link" onClick={() => { setDraft(props.value); setEditing(true); }}>
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <form className="row" onSubmit={save}>
          <input value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={props.maxLength} required={!props.allowEmpty} />
          <button className="primary">Save</button>
          <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      ) : props.render ? (
        props.render(props.value)
      ) : (
        <p className="big">{props.value}</p>
      )}
    </section>
  );
}

// ---------- Data scope ----------

function ScopePanel({ incidentId, run }: { incidentId: bigint; run: Run }) {
  const [allScope] = useTable(tables.scopeFeed);
  const addScope = useReducer(reducers.addScopeItem);
  const updateScope = useReducer(reducers.updateScopeItem);
  const items = useMemo(
    () => allScope.filter(s => s.incidentId === incidentId).sort((a, b) => a.dataName.localeCompare(b.dataName)),
    [allScope, incidentId]
  );
  const [name, setName] = useState('');
  const [status, setStatus] = useState('unknown');
  const [notes, setNotes] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => addScope({ incidentId, dataName: name.trim(), status, notes: notes.trim() }))) {
      setName('');
      setNotes('');
      setStatus('unknown');
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Data scope</h3>
        <span className="muted small">What data was hit, and what happened to it</span>
      </div>
      {items.length > 0 && (
        <table className="scope">
          <thead>
            <tr><th>Data</th><th>Status</th><th>Notes</th></tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id.toString()}>
                <td>{item.dataName}</td>
                <td>
                  <select
                    className={`scope-${item.status}`}
                    value={item.status}
                    onChange={e => run(() => updateScope({ scopeItemId: item.id, status: e.target.value, notes: item.notes }))}
                  >
                    {SCOPE_STATUSES.map(s => <option key={s}>{s}</option>)}
                  </select>
                </td>
                <td>
                  <NotesCell
                    value={item.notes}
                    onSave={v => run(() => updateScope({ scopeItemId: item.id, status: item.status, notes: v }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row wrap" onSubmit={add}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Client contracts share" required maxLength={120} />
        <select value={status} onChange={e => setStatus(e.target.value)}>
          {SCOPE_STATUSES.map(s => <option key={s}>{s}</option>)}
        </select>
        <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" />
        <button className="primary">Add</button>
      </form>
    </section>
  );
}

function NotesCell({ value, onSave }: { value: string; onSave: (v: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      className="cell-input"
      value={draft}
      placeholder="—"
      onChange={e => setDraft(e.target.value)}
      onBlur={() => { if (draft.trim() !== value) onSave(draft.trim()); }}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

// ---------- Timeline (append-only) ----------

function Timeline({ incidentId, run }: { incidentId: bigint; run: Run }) {
  const [all] = useTable(tables.timelineFeed);
  const addEntry = useReducer(reducers.addTimelineEntry);
  const entries = useMemo(
    () => all.filter(e => e.incidentId === incidentId).sort((a, b) => ms(b.createdAt) - ms(a.createdAt)),
    [all, incidentId]
  );
  const [text, setText] = useState('');

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await run(() => addEntry({ incidentId, text: text.trim() }))) setText('');
  }

  return (
    <section className="card column">
      <div className="card-head">
        <h3>Timeline</h3>
        <span className="muted small">Permanent record. Can't be edited.</span>
      </div>
      <form className="row" onSubmit={add}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Log what you did or found" maxLength={1000} required />
        <button className="primary">Log</button>
      </form>
      <ol className="timeline scroll">
        {entries.map(e => (
          <li key={e.id.toString()} className={e.authorName === 'System' || e.authorName === 'Alert bot' ? 'sys' : ''}>
            <span className="t-time mono">{timeOf(e.createdAt)}</span>
            <span>
              <strong>{e.authorName}</strong> {e.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- Chat ----------

function Chat({ incidentId, run }: { incidentId: bigint; run: Run }) {
  const { identity } = useSpacetimeDB();
  const [all] = useTable(tables.chatFeed);
  const sendChat = useReducer(reducers.sendChat);
  const messages = useMemo(
    () => all.filter(m => m.incidentId === incidentId).sort((a, b) => ms(a.sentAt) - ms(b.sentAt)),
    [all, incidentId]
  );
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ block: 'nearest' }), [messages.length]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg) return;
    setText('');
    if (!(await run(() => sendChat({ incidentId, text: msg })))) setText(msg);
  }

  return (
    <section className="card column">
      <div className="card-head">
        <h3>Chat</h3>
        <span className="muted small">Off company email and Slack</span>
      </div>
      <div className="chat scroll">
        {messages.length === 0 && <p className="muted small">No messages yet.</p>}
        {messages.map(m => {
          const mine = identity ? m.sender.isEqual(identity) : false;
          return (
            <div key={m.id.toString()} className={`msg ${mine ? 'mine' : ''}`}>
              <span className="muted small">{mine ? 'You' : m.senderName} · {timeOf(m.sentAt)}</span>
              <span className="bubble">{m.text}</span>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form className="row" onSubmit={send}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Message the team" maxLength={2000} />
        <button className="primary">Send</button>
      </form>
    </section>
  );
}

// ---------- Team & invites ----------

function TeamPanel({ isAdmin, run }: { isAdmin: boolean; run: Run }) {
  const { identity } = useSpacetimeDB();
  const [team] = useTable(tables.team);
  const [invites] = useTable(tables.inviteList);
  const createInvite = useReducer(reducers.createInvite);
  const removeResponder = useReducer(reducers.removeResponder);
  const setMyPhone = useReducer(reducers.setMyPhone);
  const [phone, setPhone] = useState('');

  const people = [...team].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const openInvites = [...invites].filter(i => !i.used).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

  async function savePhone(e: FormEvent) {
    e.preventDefault();
    if (await run(() => setMyPhone({ phone: phone.trim() }))) setPhone('');
  }

  return (
    <div className="stack wide">
      <section className="card">
        <h2>Team</h2>
        <ul className="team">
          {people.map(p => {
            const isMe = identity ? p.identity.isEqual(identity) : false;
            return (
              <li key={p.identity.toHexString()}>
                <span className={`presence ${p.online ? 'on' : ''}`} title={p.online ? 'online' : 'offline'} />
                <span className="grow">
                  {p.name} {isMe && <span className="muted">(you)</span>}
                </span>
                <span className="muted small">{p.role === 'worker' ? 'alert bot' : p.role}</span>
                {isAdmin && !isMe && (
                  <button
                    className="ghost danger-text small"
                    onClick={() => {
                      if (confirm(`Remove ${p.name}? They lose access immediately.`)) run(() => removeResponder({ identity: p.identity }));
                    }}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h3>My alert phone</h3>
        <p className="muted small">Where incident texts go. Leave empty and save to stop texts.</p>
        <form className="row" onSubmit={savePhone}>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" type="tel" />
          <button className="primary">Save</button>
        </form>
      </section>

      {isAdmin && (
        <section className="card">
          <div className="card-head">
            <h3>Invite codes</h3>
            <div className="row">
              <button className="primary" onClick={() => run(() => createInvite({ role: 'responder' }))}>New responder code</button>
              <button className="ghost" onClick={() => run(() => createInvite({ role: 'worker' }))}>New alert-bot code</button>
            </div>
          </div>
          <p className="muted small">Each code works once. Share it over a channel you trust (in person, phone call).</p>
          {openInvites.length === 0 ? (
            <p className="muted small">No unused codes.</p>
          ) : (
            <ul className="invites">
              {openInvites.map(i => (
                <li key={i.code}>
                  <code className="mono code">{i.code}</code>
                  <span className="muted small">{i.role} · {dateTimeOf(i.createdAt)}</span>
                  <button className="link small" onClick={() => navigator.clipboard?.writeText(i.code)}>Copy</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
