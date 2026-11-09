/*
 * gs-shim.mjs — Apps Script runtime shim for running the REAL sync_backend.gs in Node.
 *
 * Provides in-memory implementations of the Apps Script services used by sync_backend.gs:
 *   SpreadsheetApp, LockService, ContentService, PropertiesService, Utilities
 *
 * The real sync_backend.gs source is loaded via vm.runInNewContext against these
 * globals, so every function (readManifest_, checkinTicket_, doPost, etc.) is the
 * ACTUAL code from the file — not a re-implementation.
 *
 * Usage:
 *   import { resetSheet, getSheetState, post, provisionDeviceSecret, ctx } from './gs-shim.mjs';
 *   resetSheet([['TKT-1','Alex','','','']]);
 *   const r = post({ action: 'checkin', id: 'TKT-1', gate: 'G1', time: '...' });
 *   const state = getSheetState();
 *
 * Dual-module: works as ES module (import) and provides plain-object exports for
 * vm.runInNewContext compatibility.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- in-memory sheet state --------------------------------------------------
const sheetByName = {
  Manifest: {
    headers: ['id', 'name', 'status', 'gate', 'time', 'version'],
    rows: [],
    getDataRange() { return { getValues: () => [this.headers, ...this.rows] }; },
    clearContents() { this.rows = [this.headers]; },
    getLastRow() { return this.rows.length; },
    getRange(row, col, numRows, numCols) {
      const self = this;
      return {
        setValue(v) {
          const r = row - 2;
          const c = col - 1;
          if (r >= 0 && r < self.rows.length && c >= 0 && c < self.headers.length) {
            self.rows[r][c] = v;
          }
        },
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            const r = row - 2 + i;
            if (r >= 0 && r < self.rows.length) {
              const rowData = values[i];
              for (let j = 0; j < rowData.length; j++) {
                const c = col - 1 + j;
                if (c >= 0 && c < self.headers.length) {
                  self.rows[r][c] = rowData[j];
                }
              }
            }
          }
        },
        clearContent() {
          self.rows = [self.headers];
        },
        clearContents() {
          self.rows = [self.headers];
        }
      };
    }
  }
};

function buildSheetApi(name) {
  if (!sheetByName[name]) {
    const sheet = {
      headers: ['nonce', 'gate', 'timestamp'],
      rows: [['nonce', 'gate', 'timestamp']],
    };
    sheet.getDataRange = function () { return { getValues: () => [this.headers, ...this.rows] }; };
    sheet.clearContents = function () { this.rows = [this.headers]; };
    sheet.getLastRow = function () { return this.rows.length; };
    sheet.getRange = function (row, col, numRows, numCols) {
      const self = this;
      const range = {
        setValue(v) {
          const r = row - 2;
          const c = col - 1;
          if (r >= 0 && r < self.rows.length && c >= 0 && c < self.headers.length) {
            self.rows[r][c] = v;
          }
        },
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            const r = row - 2 + i;
            if (r >= 0 && r < self.rows.length) {
              const rowData = values[i];
              for (let j = 0; j < rowData.length; j++) {
                const c = col - 1 + j;
                if (c >= 0 && c < self.headers.length) {
                  self.rows[r][c] = rowData[j];
                }
              }
            }
          }
        },
        clearContent: function () {
          self.rows = [self.headers];
        },
        clearContents: function () {
          self.rows = [self.headers];
        }
      };
      return range;
    };
    sheetByName[name] = sheet;
  }
  return sheetByName[name];
}

const SpreadsheetApp = {
  getActiveSpreadsheet: function () {
    return {
      getSheetByName: function (name) { return buildSheetApi(name); },
      insertSheet: function (name) { return buildSheetApi(name); },
      flush: function () { }
    };
  },
};

// ---- PropertiesService mock (for device secrets) ----
const scriptPropertiesStore = new Map();
const PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (key) { return scriptPropertiesStore.get(key) || null; },
      setProperty: function (key, value) { scriptPropertiesStore.set(key, value); },
      deleteProperty: function (key) { scriptPropertiesStore.delete(key); },
      getProperties: function () {
        const obj = {};
        for (const [k, v] of scriptPropertiesStore) obj[k] = v;
        return obj;
      }
    };
  }
};

// ---- Utilities mock (for HMAC and UUID) ----
const Utilities = {
  computeHmacSha256Signature: function (value, key) {
    const hmac = createHmac('sha256', key);
    hmac.update(value);
    const digest = hmac.digest();
    // Return as byte array like Apps Script
    return Array.from(digest);
  },
  getUuid: function () {
    // Simple UUID v4 generator
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
};

// ---- Device secrets store (mock ScriptProperties) ----
const deviceSecrets = new Map();

function getDeviceSecret_(gateId) {
  return deviceSecrets.get('device_secret_' + gateId) || null;
}

function setDeviceSecret_(gateId, secret) {
  deviceSecrets.set('device_secret_' + gateId, secret);
}

function verifySignature_(body, signature, gateId) {
  if (!gateId || !signature) return false;
  const secret = getDeviceSecret_(gateId);
  if (!secret) return false;

  const expected = createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
  const provided = signature.toLowerCase();

  if (expected.length !== provided.length) return false;
  let result = 0;
  for (let i = 0; i < expected.length; i++) {
    result |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return result === 0;
}

// LockService mock
const LockService = {
  getScriptLock: function () {
    let locked = false;
    return {
      tryLock: function (timeoutMs) {
        if (locked) return false;
        locked = true;
        // Auto-release after timeout to prevent deadlocks in tests
        setTimeout(() => { locked = false; }, timeoutMs || 3000);
        return true;
      },
      releaseLock: function () { locked = false; },
      waitLock: function (timeoutMs) {
        const start = Date.now();
        while (locked) {
          if (Date.now() - start > (timeoutMs || 3000)) {
            throw new Error('timeout');
          }
        }
      }
    };
  }
};

// ContentService mock
const ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: function (content) {
    return {
      getContent: function () { return content; },
      setMimeType: function (type) { return this; }
    };
  }
};

// Load + run the real sync_backend.gs against the shim globals.
const gsSrc = readFileSync(join(__dirname, 'sync_backend.gs'), 'utf8');
const ctx = {
  SpreadsheetApp: SpreadsheetApp,
  LockService: LockService,
  ContentService: ContentService,
  PropertiesService: PropertiesService,
  Utilities: Utilities,
  console: console,
  JSON: JSON,
  Math: Math,
  Date: Date,
  String: String,
  Object: Object,
  Array: Array,
  Number: Number,
  Boolean: Boolean,
  Error: Error,
  TypeError: TypeError,
  isArray: Array.isArray,
};
runInNewContext(gsSrc, ctx);

// ---- Exported functions (defined after ctx is ready) ----
function resetSheet(rows = []) {
  sheetByName.Manifest.headers = ['id', 'name', 'status', 'gate', 'time', 'version'];
  sheetByName.Manifest.rows = rows.map(function (r) {
    const row = r.slice();
    if (row.length < 6) row.push(0);
    return row;
  });
  sheetByName.Nonces = {
    headers: ['nonce', 'gate', 'timestamp'],
    rows: [['nonce', 'gate', 'timestamp']],
    getDataRange() { return { getValues: () => [this.headers, ...this.rows] }; },
    clearContents() { this.rows = [this.headers]; },
    getLastRow() { return this.rows.length; },
    getRange(row, col, numRows, numCols) {
      const self = this;
      return {
        setValue(v) {
          const r = row - 2;
          const c = col - 1;
          if (r >= 0 && r < self.rows.length && c >= 0 && c < self.headers.length) {
            self.rows[r][c] = v;
          }
        },
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            const r = row - 2 + i;
            if (r >= 0 && r < self.rows.length) {
              const rowData = values[i];
              for (let j = 0; j < rowData.length; j++) {
                const c = col - 1 + j;
                if (c >= 0 && c < self.headers.length) {
                  self.rows[r][c] = rowData[j];
                }
              }
            }
          }
        },
        clearContent: function () {
          self.rows = [self.headers];
        },
        clearContents: function () {
          self.rows = [self.headers];
        }
      };
    }
  };
}

function getSheetState() {
  return { headers: sheetByName.Manifest.headers.slice(), rows: sheetByName.Manifest.rows.map(function (r) { return r.slice(); }) };
}

// Test helper: provision a device secret for a gate
function provisionDeviceSecret(gateId) {
  const secret = 'test-secret-' + gateId + '-' + Date.now();
  deviceSecrets.set('device_secret_' + gateId, secret);
  scriptPropertiesStore.set('device_secret_' + gateId, secret);
  return secret;
}

/**
 * Run the real `doPost` from sync_backend.gs against the current sheet state.
 *
 * Usage:
 *   import { post } from './gs-shim.mjs';
 *   const result = post({ action: 'checkin', id: 'TKT-1', gate: 'G1', time: '...' });
 *   console.log(result);
 */
function post(body, headers) {
  headers = headers || {};
  const out = ctx.doPost({
    postData: { contents: JSON.stringify(body) },
    headers: headers,
    method: 'POST',
  });
  return JSON.parse(out.getContent());
}

// ---- ESM exports (must be at top level) ----
export { ctx, sheetByName as sheet, resetSheet, getSheetState, provisionDeviceSecret, post, scriptPropertiesStore };

// ---- CommonJS-compatible exports for vm.runInNewContext / require() compatibility ----
// This allows the module to work when loaded via vm.runInNewContext() or require()
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ctx, sheet: sheetByName, resetSheet, getSheetState, provisionDeviceSecret, post };
}
// Also attach to globalThis for direct vm.runInNewContext access if needed
if (typeof globalThis !== 'undefined') {
  globalThis.__gs_shim_exports__ = { ctx, sheet: sheetByName, resetSheet, getSheetState, provisionDeviceSecret, post };
}