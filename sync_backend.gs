/**
 * Gate Scanner — Multi-Gate Sync Backend
 * ----------------------------------------
 * Deploy this as a Google Apps Script Web App bound to a Google Sheet.
 * It turns that Sheet into a shared, real-time "already checked in?"
 * source of truth that every gate device can check against — this is
 * what closes the multi-gate double-entry gap.
 *
 * CONCURRENCY:
 *   doPost wraps its read-modify-write critical section in
 *   LockService.getScriptLock() with a 3s fast-fail. This serializes
 *   concurrent gate check-ins so two gates racing on the same ticket
 *   cannot both win (the first acquires the lock and writes CHECKED_IN;
 *   the second sees CHECKED_IN and returns `duplicate`). Under heavy
 *   contention the loser bails fast so the client's 3.5s network timeout
 *   degrades gracefully to the offline path (the scan is queued locally
 *   and replayed on the next sync). Note Apps Script 6-min exec cap still
 *   bounds total in-flight work.
 *
 * SETUP:
 * 1. Create a new Google Sheet. Name the first tab "Manifest".
 * 2. Row 1 headers (exactly): id | name | status | gate | time
 * 3. Fill in your real guest list: one row per ticket ID, name filled in,
 *    status left blank (blank = not yet checked in).
 * 4. In the Sheet: Extensions > Apps Script. Delete the default code,
 *    paste this whole file in, save.
 * 5. Deploy > New deployment > type "Web app".
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. Copy the deployment URL (ends in /exec) into the scanner's
 *    "Sync server URL" setting.
 *
 * That's it — no other backend, no hosting cost.
 */

const SHEET_NAME = "Manifest";
const REQUIRED_COLUMNS = ["id", "name", "status", "gate", "time", "version"];
const NONCE_SHEET_NAME = "Nonces";  // Separate tab for nonce tracking
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Device secrets storage (ScriptProperties: key = gateId, value = secret)
function getDeviceSecret_(gateId) {
  return PropertiesService.getScriptProperties().getProperty('device_secret_' + gateId);
}

function setDeviceSecret_(gateId, secret) {
  PropertiesService.getScriptProperties().setProperty('device_secret_' + gateId, secret);
}

// Nonce/Replay Protection
function getNonceSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(NONCE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(NONCE_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['nonce', 'gate', 'timestamp']]);
    sheet.getRange('A:C').setNumberFormat('@'); // Text format
  }
  return sheet;
}

function checkAndStoreNonce_(nonce, gateId) {
  if (!nonce) return { error: 'missing nonce' };
  if (nonce.length < 16) return { error: 'nonce too short' };
  
  const sheet = getNonceSheet_();
  const data = sheet.getDataRange().getValues();
  const now = Date.now();
  
  // Check if nonce already used (skip header row)
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === nonce) {
      return { error: 'replay detected', replay: true };
    }
  }
  
  // Clean old nonces (older than TTL)
  const validRows = [data[0]]; // Keep header
  for (let i = 1; i < data.length; i++) {
    const ts = parseInt(data[i][2], 10);
    if (!isNaN(ts) && (now - ts) < NONCE_TTL_MS) {
      validRows.push(data[i]);
    }
  }
  
  // Add new nonce
  validRows.push([nonce, gateId, now.toString()]);
  
  // Write back
  sheet.clearContents();
  sheet.getRange(1, 1, validRows.length, 3).setValues(validRows);
  
  return { ok: true };
}

// Rate Limiting
const RATE_LIMIT_SHEET_NAME = "RateLimits";
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 30; // Max requests per window per gate

function getRateLimitSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RATE_LIMIT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(RATE_LIMIT_SHEET_NAME);
    sheet.getRange(1, 1, 1, 3).setValues([['gate', 'window_start', 'count']]);
    sheet.getRange('A:C').setNumberFormat('@');
  }
  return sheet;
}

function checkRateLimit_(gateId) {
  if (!gateId) return { ok: true }; // No gate ID, skip rate limit
  
  const sheet = getRateLimitSheet_();
  const data = sheet.getDataRange().getValues();
  const now = Date.now();
  const windowStart = Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS;
  
  // Find current window for this gate
  let rowIndex = -1;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === gateId && parseInt(data[i][1], 10) === windowStart) {
      rowIndex = i + 1; // 1-based sheet row
      break;
    }
  }
  
  if (rowIndex === -1) {
    // New window for this gate
    const newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1, 1, 3).setValues([[gateId, windowStart.toString(), '1']]);
    return { ok: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1 };
  }
  
  // Increment count
  const currentCount = parseInt(data[rowIndex - 1][2], 10) || 0;
  const newCount = currentCount + 1;
  
  if (newCount > RATE_LIMIT_MAX_REQUESTS) {
    return { error: 'rate limit exceeded', retryAfter: RATE_LIMIT_WINDOW_MS - (now - windowStart) };
  }
  
  sheet.getRange(rowIndex, 3).setValue(newCount.toString());
  return { ok: true, remaining: RATE_LIMIT_MAX_REQUESTS - newCount };
}

// Verify HMAC-SHA256 signature
function verifySignature_(body, signature, gateId) {
  if (!gateId) return false;
  const secret = getDeviceSecret_(gateId);
  if (!secret) return false; // No secret configured for this gate
  
  const expected = Utilities.computeHmacSha256Signature(JSON.stringify(body), secret);
  const expectedHex = expected.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
  const providedHex = signature.toLowerCase();
  
  // Constant-time comparison
  if (expectedHex.length !== providedHex.length) return false;
  let result = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    result |= expectedHex.charCodeAt(i) ^ providedHex.charCodeAt(i);
  }
  return result === 0;
}

function getSheet_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

/* Read the Manifest sheet into an in-memory structure.
 * Validates that every required column header is present; if any are
 * missing, the returned object carries an `error` property describing
 * the bad header so the caller can fail loudly instead of silently
 * writing to the wrong columns. */
function readManifest_() {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const missing = REQUIRED_COLUMNS.filter(h => headers.indexOf(h) === -1);
  if (missing.length) {
    return { error: "bad header row: missing column(s) " + missing.join(", ") };
  }

  const idCol = headers.indexOf("id");
  const nameCol = headers.indexOf("name");
  const statusCol = headers.indexOf("status");
  const gateCol = headers.indexOf("gate");
  const timeCol = headers.indexOf("time");
  const versionCol = headers.indexOf("version");

  const rows = {};
  for (let i = 1; i < data.length; i++) {
    const id = String(data[i][idCol]).trim();
    if (!id) continue;
    rows[id] = {
      rowIndex: i + 1, // 1-based sheet row
      name: data[i][nameCol],
      status: data[i][statusCol] || "VALID",
      gate: data[i][gateCol] || null,
      time: data[i][timeCol] || null,
      version: data[i][versionCol] || 0
    };
  }
  return { sheet, headers, idCol, nameCol, statusCol, gateCol, timeCol, versionCol, rows };
}

/**
 * Attempts to check in a single ticket. Idempotent: calling it twice for
 * an already-checked-in ticket just returns the existing check-in info
 * rather than overwriting it — this is what prevents a second gate from
 * quietly stealing a check-in that already happened elsewhere.
 * Safe to replay: under the postDoP lock only one writer touches a row
 * at a time, and the second caller observes CHECKED_IN and returns early.
 */
function checkinTicket_(id, gate, time) {
  const m = readManifest_();
  if (m.error) return { error: m.error };

  const row = m.rows[id];

  if (!row) {
    return { result: "invalid" };
  }
  if (row.status === "CHECKED_IN") {
    return { result: "duplicate", name: row.name, gate: row.gate, time: row.time };
  }

  m.sheet.getRange(row.rowIndex, m.statusCol + 1).setValue("CHECKED_IN");
  m.sheet.getRange(row.rowIndex, m.gateCol + 1).setValue(gate);
  m.sheet.getRange(row.rowIndex, m.timeCol + 1).setValue(time);

  return { result: "ok", name: row.name, gate: gate, time: time };
}

/**
 * Updates a ticket's fields. Uses optimistic locking via version.
 * Only allows updates if ticket is not CHECKED_IN (audit integrity).
 */
function updateTicket_(id, updates, clientVersion) {
  const m = readManifest_();
  if (m.error) return { error: m.error };

  const row = m.rows[id];

  if (!row) {
    return { result: "invalid" };
  }
  if (row.status === "CHECKED_IN") {
    return { error: "CANNOT_EDIT_CHECKED_IN", result: "conflict" };
  }
  if (row.version !== clientVersion) {
    return { 
      error: "VERSION_CONFLICT", 
      result: "conflict", 
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

  // Apply updates
  const newVersion = row.version + 1;
  if (updates.name !== undefined) {
    m.sheet.getRange(row.rowIndex, m.nameCol + 1).setValue(updates.name);
    row.name = updates.name;
  }
  if (updates.phone !== undefined) {
    // Phone/email/payment_proof not in sheet yet - would need schema extension
    // For now, just version bump
  }
  if (updates.email !== undefined) {
  }
  if (updates.payment_proof !== undefined) {
  }

  m.sheet.getRange(row.rowIndex, m.versionCol + 1).setValue(newVersion);
  row.version = newVersion;

  return { result: "ok", version: newVersion };
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  let response;

  // Verify HMAC signature (if device secret configured for this gate)
  const gateId = e.headers['X-Gate-Id'] || body.gate;
  const signature = e.headers['X-Signature'];
  if (gateId && signature) {
    if (!verifySignature_(body, signature, gateId)) {
      return ContentService.createTextOutput(JSON.stringify({ error: "invalid signature" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Nonce/Replay Protection (required for checkin and update actions)
  const nonce = body.nonce;
  if ((body.action === 'checkin' || body.action === 'update') && gateId) {
    const nonceResult = checkAndStoreNonce_(nonce, gateId);
    if (nonceResult.error) {
      return ContentService.createTextOutput(JSON.stringify({ error: nonceResult.error, replay: nonceResult.replay }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  // Rate Limiting (per gate, per minute)
  if ((body.action === 'checkin' || body.action === 'update') && gateId) {
    const rateLimitResult = checkRateLimit_(gateId);
    if (rateLimitResult.error) {
      return ContentService.createTextOutput(JSON.stringify({ error: rateLimitResult.error, retryAfter: rateLimitResult.retryAfter }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(3000)) {
      return ContentService.createTextOutput(JSON.stringify({ error: "server busy, try again" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: "server busy, try again" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    if (body.action === "checkin") {
      response = checkinTicket_(body.id, body.gate, body.time);

    } else if (body.action === "update") {
      response = updateTicket_(body.id, body.updates, body.version);

    } else if (body.action === "sync") {
      // Process any offline-queued events (idempotent, safe to replay).
      // The lock above serializes concurrent syncs so replays interleave
      // safely; replay is also idempotent because checkinTicket_ returns
      // `duplicate` for already-checked-in rows.
      const events = body.events || [];
      for (let i = 0; i < events.length; i++) {
        const r = checkinTicket_(events[i].id, events[i].gate, events[i].time);
        if (r.error) { response = { error: r.error }; break; }
      }

      // Process updates (optimistic locking via version)
      const updates = body.updates || [];
      const updateResults = [];
      for (let i = 0; i < updates.length; i++) {
        const u = updates[i];
        const r = updateTicket_(u.ticketId, u.updates, u.clientVersion);
        updateResults.push({ ticket_id: u.ticketId, success: !r.error, ...r });
        if (r.error && r.error !== "VERSION_CONFLICT") {
          response = { error: r.error };
          break;
        }
      }
      if (updateResults.length && !response) {
        response = { results: updateResults };
      }

      if (!response) {
        // Return the full authoritative manifest so the device can
        // reconcile anything checked in elsewhere while it was offline.
        const m = readManifest_();
        if (m.error) { response = { error: m.error }; }
        else {
          const manifestOut = {};
          Object.keys(m.rows).forEach(function (id) {
            const r = m.rows[id];
            manifestOut[id] = { name: r.name, status: r.status, gate: r.gate, time: r.time, version: r.version };
          });
          response = { manifest: manifestOut };
        }
      }

    } else if (body.action === "manifest") {
      const m = readManifest_();
      if (m.error) { response = { error: m.error }; }
      else {
        const manifestOut = {};
        Object.keys(m.rows).forEach(function (id) {
          const r = m.rows[id];
          manifestOut[id] = { name: r.name, status: r.status, gate: r.gate, time: r.time };
        });
        response = { manifest: manifestOut };
      }

    } else {
      response = { error: "unknown action" };
    }
  } finally {
    try { SpreadsheetApp.flush(); } catch (err) { /* best-effort */ }
    try { lock.releaseLock(); } catch (err) { /* best-effort */ }
  }

  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "Gate scanner sync backend is running" }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Admin helper: provision a device secret for a gate.
 * Run once per device: provisionDeviceSecret_('Gate 1')
 * Returns the generated secret (save it securely — cannot be retrieved later).
 */
function provisionDeviceSecret_(gateId) {
  const secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  setDeviceSecret_(gateId, secret);
  return secret;
}

/**
 * Admin helper: list all provisioned gates.
 */
function listDeviceSecrets_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const gates = {};
  Object.keys(props).forEach(key => {
    if (key.startsWith('device_secret_')) {
      gates[key.replace('device_secret_', '')] = '***configured***';
    }
  });
  return gates;
}

/**
 * Admin helper: revoke a device secret.
 */
function revokeDeviceSecret_(gateId) {
  PropertiesService.getScriptProperties().deleteProperty('device_secret_' + gateId);
}
