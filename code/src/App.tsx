import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import type { Timestamp } from 'spacetimedb';
import { tables, reducers } from './module_bindings';
import type { Incident } from './module_bindings/types';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['open', 'investigating', 'contained', 'resolved'];
const SCOPE_STATUSES = ['exfiltrated', 'encrypted', 'unknown', 'contained'];

// UI-only copy for the guided "open incident" flow.
const INCIDENT_TYPES = [
  { label: 'Ransomware', title: 'Ransomware' },
  { label: 'Data leak', title: 'Data leak' },
  { label: 'Account takeover', title: 'Account takeover' },
  { label: 'Phishing', title: 'Phishing' },
  { label: 'Lost device', title: 'Lost device' },
  { label: 'Not sure yet', title: 'Suspicious activity' },
];
const SEVERITY_HINTS: Record<string, string> = {
  low: 'One person affected',
  medium: 'Work is slowed down',
  high: 'A team or system down',
  critical: 'Business stopped or data stolen',
};

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
function incLabel(id: bigint) {
  return `INC-${id.toString().padStart(4, '0')}`;
}
function elapsed(fromMs: number, nowMs: number) {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
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

// ---------- Icons ----------

function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="logo">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M8 8l3 4-2 1 4 3" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 9v4M12 17h.01" />
      <path d="M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
    </svg>
  );
}

function Brand({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={`brand brand-${size}`}>
      <Logo size={size === 'lg' ? 36 : 28} />
      <span>Breakglass</span>
    </span>
  );
}

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
        <Brand size="lg" />
        <p className="muted">Can't reach the war room server. Check that SpacetimeDB is running and the address is right.</p>
        <code className="mono small">{import.meta.env.VITE_SPACETIME_URI ?? 'ws://localhost:3000'}</code>
      </Center>
    );
  } else if (!conn.isActive || !profileReady) {
    body = (
      <Center>
        <Brand size="lg" />
        <p className="muted">Connecting…</p>
      </Center>
    );
  } else if (!me) {
    body = <JoinScreen run={action.run} />;
  } else if (me.role === 'worker') {
    body = (
      <Center>
        <Brand size="lg" />
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
      <div className="center-col">{children}</div>
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
      <Brand size="lg" />
      <div className="stack-sm">
        <h1 className="display-md">{mode === 'join' ? 'Sign in' : 'First-time setup'}</h1>
        <p className="lede">
          {mode === 'join'
            ? 'Out-of-band war room. We never use your company login: if your network is compromised, so is SSO. Enter the one-time code your admin gave you.'
            : 'The first person to do this becomes the admin. You can invite the rest of the team after.'}
        </p>
      </div>
      <form className="stack" onSubmit={submit}>
        {mode === 'join' && (
          <label className="field">
            Invite code
            <input
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXXXXXX"
              autoFocus
              required
              className="input-lg mono code-input"
            />
          </label>
        )}
        <label className="field">
          Your name
          <input className="input-lg" value={name} onChange={e => setName(e.target.value)} required maxLength={60} autoFocus={mode === 'setup'} />
        </label>
        <label className="field">
          Phone for alerts <span className="muted normal">(optional, never shown to others)</span>
          <input className="input-lg" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" type="tel" />
        </label>
        <button className="btn btn-primary btn-lg" disabled={busy}>
          {mode === 'join' ? 'Enter Breakglass' : 'Become admin'}
        </button>
      </form>
      <div className="note">
        {mode === 'join' ? 'Not on the list? Only your admin can add responders. ' : 'Already have a code? '}
        <button className="link" onClick={() => setMode(mode === 'join' ? 'setup' : 'join')}>
          {mode === 'join' ? 'Setting this up for the first time?' : 'I have an invite code'}
        </button>
      </div>
    </Center>
  );
}

// ---------- Main shell ----------

function WarRoom({ meName, isAdmin, run }: { meName: string; isAdmin: boolean; run: Run }) {
  const [incidents] = useTable(tables.incidentsFeed);
  const [team] = useTable(tables.team);
  const [selectedId, setSelectedId] = useState<bigint | null>(null);
  const [panel, setPanel] = useState<'home' | 'incident' | 'new' | 'team'>('home');

  const sorted = useMemo(() => {
    const active = (i: Incident) => (i.status === 'resolved' ? 1 : 0);
    return [...incidents].sort((a, b) => active(a) - active(b) || ms(b.updatedAt) - ms(a.updatedAt));
  }, [incidents]);

  const selected = sorted.find(i => i.id === selectedId) ?? sorted.find(i => i.status !== 'resolved') ?? sorted[0];

  const people = team.filter(p => p.role !== 'worker');
  const onlineCount = people.filter(p => p.online).length;

  function pick(id: bigint) {
    setSelectedId(id);
    setPanel('incident');
  }

  if (panel === 'new') {
    return <NewIncident run={run} onCancel={() => setPanel('home')} onCreated={() => { setSelectedId(null); setPanel('incident'); }} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-group">
            <button className="brand-btn" onClick={() => setPanel('home')} aria-label="Breakglass home">
              <Brand />
            </button>
            <span className="env-chip">isolated · self-hosted</span>
          </span>
          <nav className="nav">
            <button className={`nav-link ${panel === 'home' || panel === 'incident' ? 'on' : ''}`} onClick={() => setPanel('home')}>
              Incidents
            </button>
            <button className={`nav-link ${panel === 'team' ? 'on' : ''}`} onClick={() => setPanel('team')}>
              {isAdmin ? 'Responders & invites' : 'Responders'}
            </button>
          </nav>
        </div>
        <div className="topbar-right">
          <span className="presence-line">
            <span className={`dot ${onlineCount > 0 ? 'dot-ok' : ''}`} />
            {onlineCount} of {people.length} responders online
          </span>
          <span className="whoami">{meName}{isAdmin ? ' · Admin' : ''}</span>
        </div>
      </header>

      {panel === 'home' && <Home incidents={sorted} peopleCount={people.length} onlineCount={onlineCount} onBreak={() => setPanel('new')} onPick={pick} onTeam={() => setPanel('team')} />}
      {panel === 'team' && <TeamPanel isAdmin={isAdmin} run={run} />}
      {panel === 'incident' &&
        (selected ? (
          <IncidentView key={selected.id.toString()} incident={selected} run={run} onBack={() => setPanel('home')} />
        ) : (
          <Home incidents={sorted} peopleCount={people.length} onlineCount={onlineCount} onBreak={() => setPanel('new')} onPick={pick} onTeam={() => setPanel('team')} />
        ))}
    </div>
  );
}

// ---------- Home ----------

function Home(props: {
  incidents: Incident[];
  peopleCount: number;
  onlineCount: number;
  onBreak: () => void;
  onPick: (id: bigint) => void;
  onTeam: () => void;
}) {
  const now = useNow();
  const active = props.incidents.filter(i => i.status !== 'resolved');
  const past = props.incidents.filter(i => i.status === 'resolved');

  return (
    <main className="page page-home">
      {active.length === 0 ? (
        <section className="empty-state">
          <h1 className="display-lg">No active incidents</h1>
          <p className="lede">
            If something looks wrong, don't wait to be sure. Opening an incident texts the whole response team instantly.
          </p>
          <button className="btn btn-primary btn-glass" onClick={props.onBreak}>
            <WarningIcon />
            Break the glass
          </button>
        </section>
      ) : (
        <>
          <section className="hero alarm">
            <div className="hero-copy">
              <h1 className="display-lg">Something wrong?</h1>
              <p className="lede">
                Opening an incident texts your whole response team instantly and gives everyone one place to work. When in doubt, break the glass.
              </p>
            </div>
            <button className="btn btn-primary btn-glass" onClick={props.onBreak}>
              <WarningIcon />
              Break the glass
            </button>
          </section>

          <section className="stack">
            <h2 className="display-sm">Active incidents</h2>
            {active.map(i => (
            <button key={i.id.toString()} className="incident-card" onClick={() => props.onPick(i.id)}>
              <span className="incident-card-main">
                <span className="pill-row">
                  <span className="mono muted small">{incLabel(i.id)}</span>
                  <SeverityPill severity={i.severity} />
                  <StatusPill status={i.status} />
                </span>
                <span className="incident-card-title">{i.title}</span>
              </span>
              <span className="incident-card-meta">
                <span>Opened {dateTimeOf(i.createdAt)}</span>
                <span className="mono accent-text">{elapsed(ms(i.createdAt), now)}</span>
                <span className="accent-text strong">Open war room →</span>
              </span>
            </button>
            ))}
          </section>
        </>
      )}

      <div className="split">
        <section className="panel stack-sm">
          <h2 className="display-xs">Team readiness</h2>
          <div className="stats">
            <div className="stat">
              <span className="stat-num">{props.peopleCount}</span>
              <span className="muted small">responders registered</span>
            </div>
            <div className="stat">
              <span className={`stat-num ${props.onlineCount > 0 ? 'ok-text' : ''}`}>{props.onlineCount}/{props.peopleCount}</span>
              <span className="muted small">online right now</span>
            </div>
          </div>
          <button className="link align-start" onClick={props.onTeam}>Manage responders →</button>
        </section>
        <section className="panel stack-sm">
          <h2 className="display-xs">Past incidents</h2>
          {past.length === 0 ? (
            <p className="muted small">Nothing resolved yet.</p>
          ) : (
            past.map(i => (
              <button key={i.id.toString()} className="row-link" onClick={() => props.onPick(i.id)}>
                <span>{incLabel(i.id)} · {i.title}</span>
                <span className="ok-text">Resolved</span>
              </button>
            ))
          )}
        </section>
      </div>
    </main>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  return <span className={`pill sev-${severity}`}>{severity}</span>;
}
function StatusPill({ status }: { status: string }) {
  return <span className={`pill status-${status}`}>{status}</span>;
}

// ---------- New incident (guided, 4 steps) ----------

function NewIncident({ run, onCreated, onCancel }: { run: Run; onCreated: () => void; onCancel: () => void }) {
  const openIncident = useReducer(reducers.openIncident);
  const [team] = useTable(tables.team);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [severity, setSeverity] = useState('high');
  const [systems, setSystems] = useState('');
  const [busy, setBusy] = useState(false);

  const people = team.filter(p => p.role !== 'worker').sort((a, b) => a.name.localeCompare(b.name));

  function pickKind(label: string, prefill: string) {
    // Prefill the title from the type, unless the user already typed their own.
    const prev = INCIDENT_TYPES.find(t => t.label === kind)?.title ?? '';
    if (!title.trim() || title === prev) setTitle(prefill);
    setKind(label);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await run(() => openIncident({ title: title.trim(), severity, affectedSystems: systems.trim() }));
    setBusy(false);
    if (ok) onCreated();
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="link muted-link" onClick={onCancel}>← Cancel</button>
        <span className="display-xs">Open an incident</span>
        <span className="muted small">Takes 30 seconds</span>
      </header>
      <main className="page page-narrow">
        <form className="steps" onSubmit={submit}>
          <section className="step">
            <h2 className="step-title">1. What's happening?</h2>
            <div className="choice-grid">
              {INCIDENT_TYPES.map(t => (
                <button
                  type="button"
                  key={t.label}
                  className={`choice ${kind === t.label ? 'on' : ''}`}
                  aria-pressed={kind === t.label}
                  onClick={() => pickKind(t.label, t.title)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="muted normal">In a few words</span>
              <input
                className="input-lg"
                value={title}
                onChange={e => setTitle(e.target.value)}
                required
                maxLength={120}
                autoFocus
                placeholder="Ransom note on file server"
              />
            </label>
          </section>

          <section className="step">
            <h2 className="step-title">2. How bad is it?</h2>
            <div className="choice-grid choice-grid-4">
              {SEVERITIES.map(s => (
                <button
                  type="button"
                  key={s}
                  className={`choice choice-tall ${severity === s ? `on on-${s}` : ''}`}
                  aria-pressed={severity === s}
                  onClick={() => setSeverity(s)}
                >
                  <span className="choice-label">{s}</span>
                  <span className="choice-hint">{SEVERITY_HINTS[s]}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="step">
            <label className="field">
              <span className="step-title">3. What's affected?</span>
              <input className="input-lg" value={systems} onChange={e => setSystems(e.target.value)} placeholder="Email, Payroll, VPN" />
            </label>
            <span className="muted">Comma-separated. Best guess is fine, you can update this in the war room.</span>
          </section>

          <section className="step">
            <h2 className="step-title">4. Who gets texted?</h2>
            <p className="muted">Every responder with a phone on file gets a text the moment you open this.</p>
            {people.length > 0 && (
              <ul className="recipients">
                {people.map(p => (
                  <li key={p.identity.toHexString()}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12l5 5L20 7" />
                    </svg>
                    <span>{p.name}</span>
                    <span className="muted small">{p.role}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <button className="btn btn-primary btn-xl" disabled={busy}>
            {busy ? 'Opening…' : 'Open incident & text the team'}
          </button>
        </form>
      </main>
    </div>
  );
}

// ---------- One incident (war room) ----------

function IncidentView({ incident, run, onBack }: { incident: Incident; run: Run; onBack: () => void }) {
  const setStatus = useReducer(reducers.setIncidentStatus);
  const setSeverity = useReducer(reducers.setIncidentSeverity);
  const setNextAction = useReducer(reducers.setNextAction);
  const setAffected = useReducer(reducers.setAffectedSystems);
  const id = incident.id;
  const now = useNow();
  const resolved = incident.status === 'resolved';

  return (
    <main className="page page-wide warroom">
      <button className="link muted-link align-start" onClick={onBack}>← All incidents</button>

      <header className="incident-head">
        <div className="stack-sm">
          <div className="pill-row">
            <span className="mono muted">{incLabel(id)}</span>
            <SeverityPill severity={incident.severity} />
            <StatusPill status={incident.status} />
          </div>
          <h1 className="display-lg">{incident.title}</h1>
          <p className="muted small">Opened {dateTimeOf(incident.createdAt)} · updated {timeOf(incident.updatedAt)}</p>
        </div>
        <div className="incident-head-right">
          {!resolved && (
            <>
              <span className="muted small">Time since opened</span>
              <span className="clock mono">{elapsed(ms(incident.createdAt), now)}</span>
            </>
          )}
          <div className="controls">
            <label className="select-field">
              Status
              <select value={incident.status} onChange={e => run(() => setStatus({ incidentId: id, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s}>{s}</option>)}
              </select>
            </label>
            <label className="select-field">
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
        </div>
      </header>

      <EditableBlock
        className="next-action alarm"
        label="Your next step"
        value={incident.nextAction}
        maxLength={200}
        editLabel="Mark done"
        editPlaceholder="What's the next step?"
        startEmpty
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

      <div className="three-col">
        <Timeline incidentId={id} run={run} />
        <ScopePanel incidentId={id} run={run} />
        <Chat incidentId={id} run={run} />
      </div>
    </main>
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
  editLabel?: string;
  editPlaceholder?: string;
  startEmpty?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.value);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (await props.onSave(draft.trim())) setEditing(false);
  }

  return (
    <section className={`panel editable ${props.className ?? ''}`}>
      <div className="editable-body">
        <h3 className="eyebrow">{props.label}</h3>
        {editing ? (
          <form className="row" onSubmit={save}>
            <input value={draft} onChange={e => setDraft(e.target.value)} autoFocus maxLength={props.maxLength} required={!props.allowEmpty} placeholder={props.editPlaceholder} aria-label={props.label} />
            <button className="btn btn-primary">Save</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        ) : props.render ? (
          props.render(props.value)
        ) : (
          <p className="editable-value">{props.value}</p>
        )}
      </div>
      {!editing && (
        <button
          className={props.editLabel ? 'btn btn-primary' : 'btn btn-ghost'}
          onClick={() => { setDraft(props.startEmpty ? '' : props.value); setEditing(true); }}
        >
          {props.editLabel ?? 'Edit'}
        </button>
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
    <section className="panel column">
      <div className="panel-head">
        <h2 className="display-xs">Data scope</h2>
        <span className="muted small">What data was hit</span>
      </div>
      {items.length > 0 && (
        <ul className="scope-list">
          {items.map(item => (
            <li key={item.id.toString()} className="scope-item">
              <div className="scope-item-top">
                <span>{item.dataName}</span>
                <select
                  aria-label={`Status of ${item.dataName}`}
                  className={`scope-select scope-${item.status}`}
                  value={item.status}
                  onChange={e => run(() => updateScope({ scopeItemId: item.id, status: e.target.value, notes: item.notes }))}
                >
                  {SCOPE_STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <NotesCell
                value={item.notes}
                onSave={v => run(() => updateScope({ scopeItemId: item.id, status: item.status, notes: v }))}
              />
            </li>
          ))}
        </ul>
      )}
      <form className="scope-add" onSubmit={add}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Client contracts share" required maxLength={120} aria-label="Data name" />
        <div className="row">
          <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
            {SCOPE_STATUSES.map(s => <option key={s}>{s}</option>)}
          </select>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" aria-label="Notes" />
        </div>
        <button className="btn btn-dashed">+ Add data</button>
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
      placeholder="Add a note…"
      aria-label="Notes"
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
    <section className="panel column">
      <div className="panel-head">
        <h2 className="display-xs">Timeline</h2>
        <span className="muted small">Permanent. Can't be edited.</span>
      </div>
      <form className="row" onSubmit={add}>
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Log what you did or found" maxLength={1000} required aria-label="Timeline entry" />
        <button className="btn btn-light">Log</button>
      </form>
      <ol className="timeline scroll">
        {entries.map(e => (
          <li key={e.id.toString()} className={e.authorName === 'System' || e.authorName === 'Alert bot' ? 'sys' : ''}>
            <span className="t-time mono">{timeOf(e.createdAt)}</span>
            <span className="t-body">
              <span>{e.text}</span>
              <span className="muted small">{e.authorName}</span>
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
    <section className="panel column">
      <div className="panel-head">
        <h2 className="display-xs">War room chat</h2>
        <span className="ok-text small">● live</span>
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
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Message the war room" maxLength={2000} aria-label="Message" />
        <button className="btn btn-light">Send</button>
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
    <main className="page page-mid">
      <div className="stack-sm">
        <h1 className="display-lg">Responders</h1>
        <p className="muted">Only people on this list can see incidents. Set this up before you need it.</p>
      </div>

      <section className="panel flush">
        <div className="table-wrap">
          <div className="t-row t-head">
            <span>Name</span><span>Status</span><span>Access</span><span />
          </div>
          {people.map(p => {
            const isMe = identity ? p.identity.isEqual(identity) : false;
            return (
              <div className="t-row" key={p.identity.toHexString()}>
                <span className="strong">
                  {p.name} {isMe && <span className="muted normal">(you)</span>}
                </span>
                <span className={p.online ? 'ok-text' : 'muted'}>
                  <span className={`dot ${p.online ? 'dot-ok' : ''}`} /> {p.online ? 'Online' : 'Offline'}
                </span>
                <span className="cap">{p.role === 'worker' ? 'alert bot' : p.role}</span>
                <span className="t-actions">
                  {isAdmin && !isMe && (
                    <button
                      className="btn btn-ghost btn-sm danger-text"
                      onClick={() => {
                        if (confirm(`Remove ${p.name}? They lose access immediately.`)) run(() => removeResponder({ identity: p.identity }));
                      }}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel stack-sm">
        <h2 className="display-xs">My alert phone</h2>
        <p className="muted small">Where incident texts go. Leave empty and save to stop texts.</p>
        <form className="row" onSubmit={savePhone}>
          <input className="input-lg" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+15551234567" type="tel" aria-label="Alert phone" />
          <button className="btn btn-primary btn-lg">Save</button>
        </form>
      </section>

      {isAdmin && (
        <section className="panel stack-sm">
          <div className="panel-head">
            <h2 className="display-xs">Invite codes</h2>
            <div className="row">
              <button className="btn btn-primary" onClick={() => run(() => createInvite({ role: 'responder' }))}>New responder code</button>
              <button className="btn btn-ghost" onClick={() => run(() => createInvite({ role: 'worker' }))}>New alert-bot code</button>
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

      <div className="note">Use personal phones, not company devices. If an attacker controls company email and phones, they shouldn't be able to reach this list.</div>
    </main>
  );
}
