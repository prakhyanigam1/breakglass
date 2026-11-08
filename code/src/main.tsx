import React from 'react';
import ReactDOM from 'react-dom/client';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';
import App from './App';
import './styles.css';

const URI = import.meta.env.VITE_SPACETIME_URI ?? 'ws://localhost:3000';
const DB_NAME = import.meta.env.VITE_DB_NAME ?? 'breakglass';
// One login token per database, so local and cloud don't clash.
const TOKEN_KEY = `breakglass-token:${URI}:${DB_NAME}`;

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const connectionBuilder = DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB_NAME)
  .withToken(readToken())
  .onConnect((conn, _identity, token) => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* private window: you'll just get a new identity next time */
    }
    conn
      .subscriptionBuilder()
      .subscribe([
        'SELECT * FROM my_profile',
        'SELECT * FROM team',
        'SELECT * FROM incidents_feed',
        'SELECT * FROM timeline_feed',
        'SELECT * FROM scope_feed',
        'SELECT * FROM chat_feed',
        'SELECT * FROM invite_list',
      ]);
  })
  .onConnectError((_ctx, err) => {
    console.error('Could not connect to SpacetimeDB:', err);
  });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <App />
    </SpacetimeDBProvider>
  </React.StrictMode>
);
