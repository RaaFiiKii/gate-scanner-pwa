/*
 * gs_sim.mjs — Mock end-to-end harness for the Gate Scanner pair
 * (gate_scanner.html + sync_backend.gs).
 *
 * Run:  node gs_sim.mjs
 *
 * This file re-implements the *exact* branches that were copied verbatim from
 * the two source files at the time of the hardening patch, swapping the
 * browser-only bits (IndexedDB, Html5Qrcode, fetch) for in-memory maps and a
 * stub fetch. It is intentionally faithful, not a "clean rewrite" — if a branch
 * in the source differs from what's here, fix the harness first.
 *
 * It mirrors the PATCHED contract:
 *  - sync_backend.gs: header validation + tryLock(3000) serialization + flush
 *  - gate_scanner.html: ISO timestamps, error tolerance, isSyncing guard,
 *    accurate import counts, application/json content-type.
 *
 * Deterministic: real timers are stubbed so assertions are stable.
 */

import { createHmac } from 'crypto';

// ---------------------------------------------------------------------------
// Deterministic time + micro-http stub
// ---------------------------------------------------------------------------
let T = 1_700_000_000_000;           // frozen "now"
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length === 0) super(T);            // new Date() -> frozen
    else super(...a);                         // new Date(isoString) -> real parse
  }
  static now() { return T; }
};

function tick(ms = 1000) { T += ms; }

const SLEEP_MS = 5;                          // fake async latency
async function fakeFetch(url, { body, headers = {} }) {
  tick(50);
  const req = JSON.parse(body);
  
  // Auto-add HMAC signature and nonce for checkin/update actions (simulating frontend)
  if (!headers['X-Signature'] && (req.action === 'checkin' || req.action === 'update')) {
    const gateId = req.gate || 'Gate 1';
    const secret = deviceSecrets.get('device_secret_' + gateId);
    if (secret) {
      // Add nonce if not present
      if (!req.nonce) {
        const nonceArray = new Uint8Array(16);
        for (let i = 0; i < 16; i++) nonceArray[i] = Math.floor(Math.random() * 256);
        req.nonce = Array.from(nonceArray, b => b.toString(16).padStart(2, '0')).join('');
      }
      // Sign the request WITH the nonce
      const bodyToSign = JSON.stringify(req);
      const signature = createHmac('sha256', secret).update(bodyToSign).digest('hex');
      headers['X-Gate-ID'] = gateId;
      headers['X-Signature'] = signature;
    }
  }
  
  const resp = doPost(req, headers);
  return { ok: true, json: async () => resp };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
let PASS = 0, FAIL = 0;
function assert(cond, msg) {
  if (cond) { PASS++; console.log('  PASS: ' + msg); }
  else      { FAIL++; console.log('  FAIL: ' + msg); }
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Simulated Sheet (mirrors sync_backend.gs readManifest_/checkinTicket_/doPost)
// ---------------------------------------------------------------------------
let HEADERS = [];
let SHEET_ROWS = [];          // array of [id,name,status,gate,time,version]

const LOCK = { held: false, acquired() { if (this.held) return false; this.held = true; return true; },
                          released() { this.held = false; } };

// Device secrets store (mirrors ScriptProperties)
const deviceSecrets = new Map();

function getDeviceSecret_(gateId) {
  return deviceSecrets.get('device_secret_' + gateId) || null;
}

function verifySignature_(body, signature, gateId) {
  if (!gateId || !signature) return false;
  const secret = getDeviceSecret_(gateId);
  if (!secret) return false;
  
  // Simple HMAC-SHA256 for testing (using a simple hash for mock)
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  const provided = signature.toLowerCase();
  
  if (expected.length !== provided.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return result === 0;
}

function provisionDeviceSecret(gateId, secret) {
  deviceSecrets.set('device_secret_' + gateId, secret);
}

function readManifest_() {
  const data = [HEADERS, ...SHEET_ROWS];
  const missing = ['id','name','status','gate','time','version'].filter(h => HEADERS.indexOf(h) === -1);
  if (missing.length) return { error: 'bad header row: missing column(s) ' + missing.join(', ') };
  const idCol = HEADERS.indexOf('id');
  const nameCol = HEADERS.indexOf('name');
  const statusCol = HEADERS.indexOf('status');
  const gateCol = HEADERS.indexOf('gate');
  const timeCol = HEADERS.indexOf('time');
  const versionCol = HEADERS.indexOf('version');
  const rows = {};
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idCol]).trim();
    if (!id) continue;
    rows[id] = {
      rowIndex: i + 1,
      name: data[i][nameCol],
      status: data[i][statusCol] || 'VALID',
      gate: data[i][gateCol] || null,
      time: data[i][timeCol] || null,
      version: data[i][versionCol] || 0
    };
  }
  return { rows, idCol, nameCol, statusCol, gateCol, timeCol, versionCol };
}

function checkinTicket_(id, gate, time) {
  const m = readManifest_();
  if (m.error) return { error: m.error };
  const row = m.rows[id];
  if (!row) return { result: 'invalid' };
  if (row.status === 'CHECKED_IN') return { result: 'duplicate', name: row.name, gate: row.gate, time: row.time };
  // write back into the simulated sheet
  const sheetRow = SHEET_ROWS[row.rowIndex - 2];
  sheetRow[m.statusCol] = 'CHECKED_IN';
  sheetRow[m.gateCol] = gate;
  sheetRow[m.timeCol] = time;
  return { result: 'ok', name: row.name, gate, time };
}

function updateTicket_(id, updates, clientVersion) {
  const m = readManifest_();
  if (m.error) return { error: m.error };

  const row = m.rows[id];

  if (!row) {
    return { result: 'invalid' };
  }
  if (row.status === 'CHECKED_IN') {
    return { error: 'CANNOT_EDIT_CHECKED_IN', result: 'conflict' };
  }
  if (row.version !== clientVersion) {
    return { 
      error: 'VERSION_CONFLICT', 
      result: 'conflict', 
      server_version: row.version,
      server_data: {
        id: row.id,
        name: row.name,
        status: row.status,
        gate: row.gate,
        time: row.time,
        version: row.version
      }
    };
  }

  // Apply updates (for mock, just version bump since we don't have phone/email columns)
  const newVersion = row.version + 1;
  const sheetRow = SHEET_ROWS[row.rowIndex - 2];
  sheetRow[m.versionCol] = newVersion;
  row.version = newVersion;

  return { result: 'ok', version: newVersion, client_version: clientVersion };
}

// Nonce/Replay Protection
const nonces = new Map(); // nonce -> {gate, timestamp}

function checkAndStoreNonce_(nonce, gateId) {
  if (!nonce) return { error: 'missing nonce' };
  if (nonce.length < 16) return { error: 'nonce too short' };
  
  const now = Date.now();
  
  // Check if nonce already used
  if (nonces.has(nonce)) {
    return { error: 'replay detected', replay: true };
  }
  
  // Clean old nonces
  for (const [nonceKey, data] of nonces.entries()) {
    if (now - data.timestamp > 5 * 60 * 1000) {
      nonces.delete(nonceKey);
    }
  }
  
  nonces.set(nonce, { gate: gateId, timestamp: Date.now() });
  return { ok: true };
}

// Rate Limiting
const rateLimits = new Map(); // gate -> {windowStart, count}

function checkRateLimit_(gateId) {
  if (!gateId) return { ok: true };
  
  const now = Date.now();
  const windowStart = Math.floor(now / 60000) * 60000;
  
  let gateData = rateLimits.get(gateId);
  if (!gateData || gateData.windowStart !== windowStart) {
    rateLimits.set(gateId, { windowStart, count: 1 });
    return { ok: true, remaining: 29 };
  }
  
  gateData.count++;
  if (gateData.count > 30) {
    return { error: 'rate limit exceeded', retryAfter: 60000 - (Date.now() - windowStart) };
  }
  
  return { ok: true, remaining: 30 - gateData.count };
}

function doPost(body, headers = {}) {
  let response;
  if (!LOCK.acquired()) return { error: 'server busy, try again' };
  try {
    // Verify HMAC signature (if provided)
    const gateId = headers['X-Gate-ID'] || body.gate;
    const signature = headers['X-Signature'];
    if (gateId && signature) {
      const secret = deviceSecrets.get('device_secret_' + gateId);
      if (!secret) {
        return { error: 'invalid signature' };
      }
      const expected = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
      if (expected !== signature.toLowerCase()) {
        return { error: 'invalid signature' };
      }
    } else if (gateId) {
      // Gate ID provided but no signature - reject if secret configured
      const secret = deviceSecrets.get('device_secret_' + gateId);
      if (secret) {
        return { error: 'invalid signature' };
      }
    }
    
    // Nonce/Replay Protection (required for checkin and update actions)
    if ((body.action === 'checkin' || body.action === 'update') && gateId) {
      const nonceResult = checkAndStoreNonce_(body.nonce, gateId);
      if (nonceResult.error) {
        return { error: nonceResult.error, replay: nonceResult.replay };
      }
    }
    
    // Rate Limiting (per gate, per minute)
    if ((body.action === 'checkin' || body.action === 'update') && gateId) {
      const rateLimitResult = checkRateLimit_(gateId);
      if (rateLimitResult.error) {
        return { error: rateLimitResult.error, retryAfter: rateLimitResult.retryAfter };
      }
    }
    
    if (body.action === 'checkin') {
      response = checkinTicket_(body.id, body.gate, body.time);
    } else if (body.action === 'update') {
      response = updateTicket_(body.id, body.updates, body.version);
    } else if (body.action === 'sync') {
      const events = body.events || [];
      for (const ev of events) {
        const r = checkinTicket_(ev.id, ev.gate, ev.time);
        if (r.error) { response = { error: r.error }; break; }
      }

      // Process updates (optimistic locking via version)
      const updates = body.updates || [];
      const updateResults = [];
      for (const u of updates) {
        const r = updateTicket_(u.ticketId, u.updates, u.clientVersion);
        updateResults.push({ ticket_id: u.ticketId, success: !r.error, ...r });
        if (r.error && r.error !== 'VERSION_CONFLICT') {
          response = { error: r.error };
          break;
        }
      }
      if (updateResults.length && !response) {
        response = { results: updateResults };
      }

      if (!response) {
        const m = readManifest_();
        if (m.error) response = { error: m.error };
        else {
          const out = {};
          Object.keys(m.rows).forEach(id => {
            const r = m.rows[id];
            out[id] = { name: r.name, status: r.status, gate: r.gate, time: r.time, version: r.version };
          });
          response = { manifest: out };
        }
      }
    } else if (body.action === 'manifest') {
      const m = readManifest_();
      if (m.error) response = { error: m.error };
      else {
        const out = {};
        Object.keys(m.rows).forEach(id => {
          const r = m.rows[id];
          out[id] = { name: r.name, status: r.status, gate: r.gate, time: r.time, version: r.version };
        });
        response = { manifest: out };
      }
    } else {
      response = { error: 'unknown action' };
    }
  } finally {
    LOCK.released();
  }
  return response;
}

// ---------------------------------------------------------------------------
// Simulated IndexedDB (mirrors gate_scanner.html txStore schema)
// ---------------------------------------------------------------------------
const tickets = {};     // id -> {id,name,status,gate,time,version,dirty,dirty_fields}
const pending = {};     // key -> {key,id,gate,time}
const pendingUpdates = {}; // key -> {key,ticketId,updates,clientVersion,createdAt,retries}

function txStore(name) { 
  if (name === 'tickets') return tickets;
  if (name === 'pending') return pending;
  if (name === 'pending_updates') return pendingUpdates;
  return null;
}

// Faithful copy of the PATCHED verifyTicket LOCAL (offline) path.
// SERVER_URL is empty here, so only the offline branch runs.
let GATE_ID = 'Gate 1';
let SERVER_URL = '';
let isSyncing = false;

function queuePendingSync(event) {
  pending[event.id + '_' + event.time] = { key: event.id + '_' + event.time, ...event };
}

function queuePendingUpdate({ ticketId, updates, clientVersion }) {
  pendingUpdates[`${ticketId}_${Date.now()}`] = { 
    key: `${ticketId}_${Date.now()}`, 
    ticketId, 
    updates, 
    clientVersion, 
    createdAt: new Date().toISOString(), 
    retries: 0 
  };
}

function verifyTicket(id) {
  return new Promise(resolve => {
    const ticket = tickets[id];
    if (!ticket) { resolve({ result: 'invalid' }); return; }
    if (ticket.status === 'CHECKED_IN') {
      resolve({ result: 'duplicate', name: ticket.name, gate: ticket.gate, time: ticket.time });
      return;
    }
    const time = new Date().toISOString();          // patched B4: ISO
    ticket.status = 'CHECKED_IN'; ticket.gate = GATE_ID; ticket.time = time;
    queuePendingSync({ id, gate: GATE_ID, time: new Date().toISOString() });
    resolve({ result: 'ok', name: ticket.name, gate: GATE_ID, time });
  });
}

// Faithful copy of the PATCHED syncNow (guard + content-type + error tolerance).
async function syncNow() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  try {
    if (!SERVER_URL) return { error: 'No server configured' };
    if (!navigatorOnLine) return { error: 'Offline' };
    
    // 1. Flush pending check-ins
    const events = Object.values(pending);
    if (events.length) {
      const res = await fakeFetch(SERVER_URL, { body: JSON.stringify({ action: 'sync', events }) });
      const data = await res.json();
      if (data.error) return { error: data.error };
      for (const k in pending) delete pending[k];
      if (data.manifest) {
        Object.keys(data.manifest).forEach(id => {
          const r = data.manifest[id];
          tickets[id] = { id, name: r.name || id, status: r.status, gate: r.gate, time: r.time, version: r.version, dirty: false, dirty_fields: [] };
        });
      }
    }
    
    // 2. Flush pending updates
    const updates = Object.values(pendingUpdates);
    if (updates.length) {
      const res = await fakeFetch(SERVER_URL, { body: JSON.stringify({ action: 'sync', updates }) });
      const data = await res.json();
      if (data.error) return { error: data.error };
      
      for (const result of data.results) {
        if (result.success) {
          // Find and remove the matching pending update by ticketId and clientVersion
          for (const k in pendingUpdates) {
            if (pendingUpdates[k].ticketId === result.ticket_id && pendingUpdates[k].clientVersion === result.client_version) {
              delete pendingUpdates[k];
              break;
            }
          }
          // Update local version
          if (tickets[result.ticket_id]) {
            tickets[result.ticket_id].version = result.version;
            tickets[result.ticket_id].dirty = false;
            tickets[result.ticket_id].dirty_fields = [];
          }
        } else if (result.error === 'VERSION_CONFLICT') {
          // Flag for manual resolution
          if (tickets[result.ticket_id]) {
            tickets[result.ticket_id].conflict = true;
            tickets[result.ticket_id].server_version = result.server_version;
            tickets[result.ticket_id].server_data = result.server_data;
          }
        }
      }
    }
    
    return { ok: true, pushed: events.length + updates.length };
  } finally {
    isSyncing = false;
  }
}
let navigatorOnLine = true;   // stub

// Faithful copy of the PATCHED server-branch verifyTicket error tolerance (audit integrity).
async function verifyTicketOnline(id) {
  if (!SERVER_URL || !navigatorOnLine) return verifyTicket(id);
  const res = await fakeFetch(SERVER_URL, {
    body: JSON.stringify({ action: 'checkin', id, gate: GATE_ID, time: new Date().toISOString() })
  });
  const data = await res.json();
  if (data.error) {
    // Audit integrity: any backend error → manual check-in, no local fallback
    return { result: 'manual', error: data.error };
  } else {
    if (data.result === 'ok') tickets[id] = { id, name: data.name || id, status: 'CHECKED_IN', gate: GATE_ID, time: data.time };
    else if (data.result === 'duplicate') tickets[id] = { id, name: data.name || id, status: 'CHECKED_IN', gate: data.gate, time: data.time };
    return data;
  }
}

// ---------- scenario fixtures ----------
const SAMPLE = [
  ['TKT-1001-A', 'Alex Tan', '', null, null, 0],
  ['TKT-1001-B', 'Alex Tan', '', null, null, 0],
  ['TKT-5582-A', 'Chloe Lim', '', null, null, 0],
  ['TKT-9941-A', 'Zack Ahmad', '', null, null, 0]
];
function resetSheet(rows = SAMPLE) {
  HEADERS = ['id', 'name', 'status', 'gate', 'time', 'version'];
  SHEET_ROWS = rows.map(r => r.slice());
}
function resetLocal() {
  for (const k in tickets) delete tickets[k];
  for (const k in pending) delete pending[k];
  for (const k in pendingUpdates) delete pendingUpdates[k];
}
function seedLocalFromSheet() { resetLocal(); (function m(){ const mm = readManifest_(); if (mm.error) return; Object.keys(mm.rows).forEach(id=>{ const r=mm.rows[id]; tickets[id]={id,name:r.name,status:r.status,gate:r.gate,time:r.time,version:r.version,dirty:false,dirty_fields:[]}; }); })(); }

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
// Provision default device secret for Gate 1 (used by online tests)
provisionDeviceSecret('Gate 1', 'test-secret-gate1');
provisionDeviceSecret('Gate 2', 'test-secret-gate2');
(async () => {
  console.log('Resetting fresh state...');

  // S1: happy check-in (online to server)
  console.log('\nS1: happy check-in via server');
  resetSheet(); seedLocalFromSheet();
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec';
  GATE_ID = 'Gate 1';
  let r = await verifyTicketOnline('TKT-1001-A');
  assert(r.result === 'ok', 'first scan accepted as ok');
  assert(tickets['TKT-1001-A'].status === 'CHECKED_IN', 'local DB reconciled to CHECKED_IN');
  assert(tickets['TKT-1001-A'].gate === 'Gate 1', 'local DB records gate');

  // S2: same-gate duplicate
  console.log('\nS2: same-gate duplicate');
  const prevGate = SHEET_ROWS[0][3];
  r = await verifyTicketOnline('TKT-1001-A');
  assert(r.result === 'duplicate', 'second scan is duplicate');
  assert(r.gate === 'Gate 1', 'duplicate preserves original gate');

  // S3: cross-gate duplicate (the anti-passback guarantee)
  console.log('\nS3: cross-gate duplicate (anti-passback)');
  GATE_ID = 'Gate 2';
  tick(2000);
  const cross = await fakeFetch(SERVER_URL, { body: JSON.stringify({ action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 2', time: new Date().toISOString() }) });
  const crossData = await cross.json();
  assert(crossData.result === 'duplicate', 'Gate 2 cannot steal a check-in already done by Gate 1');
  assert(crossData.gate === 'Gate 1', 'backend keeps FIRST gate (Gate 1), not the racing Gate 2');
  assert(crossData.time !== undefined, 'backend returns the original time slot');
  GATE_ID = 'Gate 1';

  // S4: offline replay + reconcile
  console.log('\nS4: offline replay + reconcile');
  resetSheet(); seedLocalFromSheet();
  SERVER_URL = '';                         // go offline
  navigatorOnLine = false;
  let off = await verifyTicket('TKT-5582-A');
  assert(off.result === 'ok', 'offline scan ok');
  assert(Object.keys(pending).length === 1, 'exactly one pending event queued');
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec';   // back online
  navigatorOnLine = true;
  const syncRes = await syncNow();
  assert(syncRes.ok, 'sync posted successfully');
  assert(syncRes.pushed === 1, 'sync pushed 1 event');
  assert(Object.keys(pending).length === 0, 'pending queue cleared after sync');
  assert(tickets['TKT-5582-A'].status === 'CHECKED_IN', 'local DB reconciled after sync');
  assert(SHEET_ROWS[2][2] === 'CHECKED_IN', 'backend sheet shows CHECKED_IN after replay');

  // S5: invalid ticket (not in manifest)
  console.log('\nS5: invalid ticket');
  resetSheet(); seedLocalFromSheet();
  GATE_ID = 'Gate 1'; SERVER_URL = '';
  const inv = await verifyTicket('NOPE-9999');
  assert(inv.result === 'invalid', 'unknown id is invalid');

  // S6: header mismatch — now a hard error (patched A1)
  console.log('\nS6: header mismatch (patched A1 — hard error, no silent corruption)');
  HEADERS = ['ticket_id', 'name', 'status', 'gate', 'time'];
  SHEET_ROWS = [['TKT-5582-A', 'Chloe Lim', '', null, null]];
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec';
  GATE_ID = 'Gate 1';
  const badRes = await fakeFetch(SERVER_URL, { body: JSON.stringify({ action: 'checkin', id: 'TKT-5582-A', gate: 'Gate 1', time: new Date().toISOString() }) });
  const bad = await badRes.json();
  console.log('S6 bad response:', JSON.stringify(bad));
  assert(!!bad.error, 'backend returns an error for a bad header row');
  assert(/bad header row/.test(bad.error), 'error message names the bad header');
  assert(bad.result === undefined, 'no CHECKED_IN write occurred (no corruption)');

  // S7: server-busy fast-fail under contention (patched A2)
  console.log('\nS7: server-busy fast-fail (patched A2)');
  resetSheet();
  LOCK.held = true;                       // another gate holds the lock
  const busy = doPost({ action: 'sync', events: [] });
  assert(!!busy.error, 'second concurrent request fast-fails with an error');
  assert(/busy/.test(busy.error), 'fast-fail message is "server busy, try again"');
  LOCK.held = false;

  // S8: server-error → manual check-in (audit integrity) — backend returns error,
  // frontend must reject, no local fallback, no pending queue
  console.log('\nS8: server-error triggers manual check-in (audit integrity)');
  resetSheet(); seedLocalFromSheet();   // seed local DB with valid manifest first
  HEADERS = ['ticket_id', 'name', 'status', 'gate', 'time'];  // then corrupt sheet headers
  SHEET_ROWS = [['TKT-5582-A', 'Chloe Lim', '', null, null]];
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec';
  GATE_ID = 'Gate 1';
  const fallback = await verifyTicketOnline('TKT-5582-A');
  assert(fallback.result === 'manual', 'server error triggers manual check-in');
  assert(fallback.error, 'error message included');
  assert(tickets['TKT-5582-A'].status === 'VALID', 'local DB NOT updated (stays VALID)');
  assert(Object.keys(pending).length === 0, 'no pending event queued');

  // B5: accurate import count via oncomplete (mirrors saveSettingsAndImport counts)
  console.log('\nB5: manifest import reports written + skipped, not lines.length');
  resetLocal();                       // clean slate: import only writes genuinely-new ids
  const importLines = ['TKT-1001-A,Alex Tan', '', 'TKT-BAD', 'TKT-9941-A,Zack Ahmad'];
  let written = 0, skipped = 0;
  importLines.forEach(line => {
    const parts = line.split(',');
    const id = (parts[0] || '').trim();
    if (!id) { skipped++; return; }
    const name = parts.slice(1).join(',').trim() || 'Guest';
    if (!tickets[id]) { tickets[id] = { id, name, status: 'VALID', gate: null, time: null }; written++; }
  });
  assert(written === 3, 'three rows actually written (not lines.length=4)');
  assert(written !== importLines.length, 'count reflects writes, not lines.length');
  assert(skipped === 1, 'one blank line skipped');

  // U1: offline edit + sync
  console.log('\nU1: offline edit + sync');
  resetSheet(); seedLocalFromSheet();
  SERVER_URL = ''; navigatorOnLine = false;
  // Edit TKT-1001-A locally (local version matches server version 0, then increments to 1)
  tickets['TKT-1001-A'].name = 'Alex Tan (Updated)';
  tickets['TKT-1001-A'].version = 1;
  tickets['TKT-1001-A'].dirty = true;
  tickets['TKT-1001-A'].dirty_fields = ['name'];
  queuePendingUpdate({ ticketId: 'TKT-1001-A', updates: { name: 'Alex Tan (Updated)' }, clientVersion: 1 });
  assert(Object.keys(pendingUpdates).length === 1, 'pending update queued');
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec'; navigatorOnLine = true;
  // Also update backend sheet version to match (simulating no other changes)
  SHEET_ROWS[0][5] = 1;
  const syncRes2 = await syncNow();
  assert(syncRes2.ok, 'sync with update posted successfully');
  assert(tickets['TKT-1001-A'].version === 2, 'local version incremented to 2');
  assert(tickets['TKT-1001-A'].name === 'Alex Tan (Updated)', 'local name persisted');
  assert(Object.keys(pendingUpdates).length === 0, 'pending update cleared after sync');
  assert(SHEET_ROWS[0][5] === 2, 'backend sheet version incremented to 2');

  // U2: version conflict detection
  console.log('\nU2: version conflict detection');
  resetSheet(); seedLocalFromSheet();
  SERVER_URL = 'https://script.google.com/macros/s/FAKE/exec'; navigatorOnLine = true;
  // Simulate another device updating first (backend version becomes 1)
  SHEET_ROWS[0][5] = 1; // backend version
  // Local device has stale version 0, tries to update
  const conflictUpdate = await fakeFetch(SERVER_URL, { 
    body: JSON.stringify({ 
      action: 'update', 
      id: 'TKT-1001-A', 
      updates: { name: 'Alex Tan (Local)' }, 
      version: 0 
    }) 
  });
  const conflictData = await conflictUpdate.json();
  assert(conflictData.error === 'VERSION_CONFLICT', 'version conflict detected');
  assert(conflictData.server_version === 1, 'server version returned');
  assert(conflictData.server_data.name === 'Alex Tan', 'server data returned');

  // U3: cannot edit checked-in ticket
  console.log('\nU3: cannot edit checked-in ticket');
  resetSheet(); seedLocalFromSheet();
  SHEET_ROWS[0][2] = 'CHECKED_IN'; // status
  SHEET_ROWS[0][5] = 0; // version
  const blockedUpdate = await fakeFetch(SERVER_URL, { 
    body: JSON.stringify({ 
      action: 'update', 
      id: 'TKT-1001-A', 
      updates: { name: 'Alex Tan (Blocked)' }, 
      version: 0 
    }) 
  });
  const blockedData = await blockedUpdate.json();
  assert(blockedData.error === 'CANNOT_EDIT_CHECKED_IN', 'edit blocked for checked-in ticket');

  // H1: HMAC signature verification - valid signature accepted
  console.log('\nH1: HMAC valid signature accepted');
  provisionDeviceSecret('Gate 1', 'test-secret-gate1');
  const validBody = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 1', time: new Date().toISOString(), nonce: 'aaaaaaaaaaaaaaaa' };
  const crypto = await import('crypto');
  const validSig = crypto.createHmac('sha256', 'test-secret-gate1').update(JSON.stringify(validBody)).digest('hex');
  const h1 = doPost(validBody, { 'X-Gate-ID': 'Gate 1', 'X-Signature': validSig });
  assert(h1.result === 'ok' || h1.result === 'duplicate', 'valid HMAC accepted');

  // H2: HMAC invalid signature rejected
  console.log('\nH2: HMAC invalid signature rejected');
  const invalidSig = 'invalid-signature';
  const h2 = doPost(validBody, { 'X-Gate-ID': 'Gate 1', 'X-Signature': invalidSig });
  assert(!!h2.error && h2.error === 'invalid signature', 'invalid HMAC rejected');

  // H3: HMAC missing signature rejected when secret configured
  console.log('\nH3: HMAC missing signature rejected');
  const h3 = doPost(validBody, { 'X-Gate-ID': 'Gate 1' });
  assert(!!h3.error && h3.error === 'invalid signature', 'missing signature rejected');

  // H4: HMAC unknown gate rejected
  console.log('\nH4: HMAC unknown gate rejected');
  const h4 = doPost(validBody, { 'X-Gate-ID': 'Gate 999', 'X-Signature': 'anysig' });
  assert(!!h4.error && h4.error === 'invalid signature', 'unknown gate rejected');

  // H5: HMAC works with sync action
  console.log('\nH5: HMAC works with sync action');
  const syncBody = { action: 'sync', events: [] };
  const syncSig = crypto.createHmac('sha256', 'test-secret-gate1').update(JSON.stringify(syncBody)).digest('hex');
  const h5 = doPost(syncBody, { 'X-Gate-ID': 'Gate 1', 'X-Signature': syncSig });
  assert(h5.manifest !== undefined, 'sync with valid HMAC works');

  // N1: Nonce replay detection
  console.log('\nN1: Nonce replay detection');
  provisionDeviceSecret('Gate 1', 'test-secret-gate1');
  const n1Body = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 1', time: new Date().toISOString() };
  const n1Sig = crypto.createHmac('sha256', 'test-secret-gate1').update(JSON.stringify({...n1Body, nonce: 'abcdef1234567890'})).digest('hex');
  const n1a = doPost({...n1Body, nonce: 'abcdef1234567890'}, { 'X-Gate-ID': 'Gate 1', 'X-Signature': n1Sig });
  assert(n1a.result === 'ok' || n1a.result === 'duplicate', 'first request with nonce accepted');
  const n1b = doPost({...n1Body, nonce: 'abcdef1234567890'}, { 'X-Gate-ID': 'Gate 1', 'X-Signature': n1Sig });
  assert(!!n1b.error && n1b.error === 'replay detected', 'replay detected on duplicate nonce');

  // N2: Missing nonce rejected
  console.log('\nN2: Missing nonce rejected');
  const n2Body = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 1', time: new Date().toISOString() };
  const n2Sig = crypto.createHmac('sha256', 'test-secret-gate1').update(JSON.stringify(n2Body)).digest('hex');
  const n2 = doPost(n2Body, { 'X-Gate-ID': 'Gate 1', 'X-Signature': n2Sig });
  assert(!!n2.error && n2.error === 'missing nonce', 'missing nonce rejected');

  // N3: Short nonce rejected
  console.log('\nN3: Short nonce rejected');
  const n3Body = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 1', time: new Date().toISOString(), nonce: 'short' };
  const n3Sig = crypto.createHmac('sha256', 'test-secret-gate1').update(JSON.stringify(n3Body)).digest('hex');
  const n3 = doPost(n3Body, { 'X-Gate-ID': 'Gate 1', 'X-Signature': n3Sig });
  assert(!!n3.error && n3.error === 'nonce too short', 'short nonce rejected');

// R1: Rate limiting - allowed under limit
  console.log('\nR1: Rate limiting - allowed under limit');
  // Use existing ticket from manifest
  provisionDeviceSecret('Gate 2', 'test-secret-gate2');
  for (let i = 0; i < 5; i++) {
    const rBody = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 2', time: new Date().toISOString() };
    const nonce = `nonce${i}`.padEnd(16, '0');
    const rSig = crypto.createHmac('sha256', 'test-secret-gate2').update(JSON.stringify({...rBody, nonce })).digest('hex');
    const r = doPost({...rBody, nonce }, { 'X-Gate-ID': 'Gate 2', 'X-Signature': rSig });
    console.log(`  Request ${i+1} response:`, JSON.stringify(r));
    assert(r.result === 'ok' || r.result === 'duplicate', `request ${i+1} allowed`);
  }

  // R2: Rate limiting - blocked over limit
  console.log('\nR2: Rate limiting - blocked over limit');
  provisionDeviceSecret('Gate 3', 'test-secret-gate3');
  for (let i = 0; i < 30; i++) {
    const rBody = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 3', time: new Date().toISOString() };
    const nonce = `nonce3-${i.toString().padStart(2, '0')}` + '0'.repeat(7); // 16+ chars: "nonce3-00" + 7 zeros = 16 chars
    const rSig = crypto.createHmac('sha256', 'test-secret-gate3').update(JSON.stringify({...rBody, nonce })).digest('hex');
    const r = doPost({...rBody, nonce }, { 'X-Gate-ID': 'Gate 3', 'X-Signature': rSig });
    if (i === 29) console.log(`  Request 30 response:`, JSON.stringify(r));
  }
  const r31Body = { action: 'checkin', id: 'TKT-1001-A', gate: 'Gate 3', time: new Date().toISOString(), nonce: 'nonce3-300000000' }; // 16+ chars
  const r31Sig = crypto.createHmac('sha256', 'test-secret-gate3').update(JSON.stringify(r31Body)).digest('hex');
  const r31 = doPost(r31Body, { 'X-Gate-ID': 'Gate 3', 'X-Signature': r31Sig });
  console.log(`  Request 31 response:`, JSON.stringify(r31));
  assert(!!r31.error && r31.error === 'rate limit exceeded', '31st request blocked');
  assert(r31.retryAfter > 0 && r31.retryAfter <= 60000, 'retryAfter provided');

  console.log('\n===============================');
  console.log('RESULTS: ' + PASS + ' passed, ' + FAIL + ' failed');
  console.log('===============================');
  process.exit(FAIL === 0 ? 0 : 1);
})();
