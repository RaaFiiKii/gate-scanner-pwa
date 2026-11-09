# Gate Scanner — Apps Script Backend Deployment Guide

Deploy `sync_backend.gs` as a Google Apps Script web app to enable cross-gate sync, HMAC authentication, nonce replay protection, rate limiting, and audit logging.

---

## Prerequisites

- Google account with access to [script.google.com](https://script.google.com)
- Google Sheets (for the Manifest, Nonces, and RateLimits sheets)
- Gate Scanner PWA loaded at `https://raafiikii.github.io/gate-scanner-pwa/`

---

## Step 1: Create the Apps Script Project

1. Go to [https://script.google.com](https://script.google.com)
2. Click **"New Project"**
3. Rename the project from "Untitled project" to **"Gate Scanner Backend"**
4. Delete the default `Code.gs` file
5. Create a new file named `sync_backend.gs`
6. Paste the entire contents of `sync_backend.gs` from this repository into the file
7. Click the **Save** icon (or press `Ctrl+S` / `Cmd+S`)

---

## Step 2: Create the Required Sheets

The backend reads from and writes to three sheets in a Google Spreadsheet:

| Sheet Name | Purpose | Required Columns |
|------------|---------|------------------|
| `Manifest` | Ticket registry | `id`, `name`, `status`, `gate`, `time`, `version` |
| `Nonces`   | Nonce replay protection | `nonce`, `gate`, `timestamp` |
| `RateLimits` | Per-gate rate limiting | `gate`, `count`, `window_start` |

### Create the Spreadsheet

1. Go to [https://sheets.google.com](https://sheets.google.com)
2. Create a new spreadsheet named **"Gate Scanner Data"**
3. Create three sheets (tabs) with the exact names above

### Create the Manifest Sheet

In the `Manifest` tab:
- Row 1 (headers): `id`, `name`, `status`, `gate`, `time`, `version`
- Row 2+: One row per ticket (example: `TKT-1001-A`, `Alex Tan`, `VALID`, ``, ``, `0`)
- Leave `gate`, `time`, and `version` empty for unchecked-in tickets

### Create the Nonces Sheet

In the `Nonces` tab:
- Row 1 (headers): `nonce`, `gate`, `timestamp`
- No data rows needed (backend auto-manages)

### Create the RateLimits Sheet

In the `RateLimits` tab:
- Row 1 (headers): `gate`, `count`, `window_start`
- No data rows needed (backend auto-manages)

---

## Step 3: Bind the Script to the Spreadsheet

1. Return to the Apps Script editor at [https://script.google.com](https://script.google.com)
2. Click the **Project Settings** icon (gear ⚙️) on the left sidebar
3. Find **"Add a project to a spreadsheet"** or click **"Bind to spreadsheet"**
4. Select the **"Gate Scanner Data"** spreadsheet you created
5. Save

This allows `sync_backend.gs` to read/write to your sheets via `SpreadsheetApp.getActiveSpreadsheet()`.

---

## Step 4: Deploy as a Web App

1. Click the **Deploy** button → **"New deployment"**
2. Click **"Select type"** → choose **"Web app"**
3. Configure:
   - **Description**: `Gate Scanner Backend v1`
   - **Execute as**: `Me` (your account)
   - **Who has access**: `Anyone` (this allows gate scanners to POST to it)
4. Click **Deploy**
5. Authorize the script when prompted (click "Advanced" → "Go to Gate Scanner Backend (unsafe)" → "Allow")
6. **Copy the Web App URL** — it looks like:
   `https://script.google.com/macros/s/ABC123.../exec`

> ⚠️ Keep this URL private. Anyone with it can send check-in requests to your backend.

---

## Step 5: Configure the Gate Scanner PWA

1. Open `https://raafiikii.github.io/gate-scanner-pwa/`
2. Click **"Settings & manifest import"** to expand the settings panel
3. Fill in:
   - **Gate ID**: e.g., `Gate 1` (must match what you use in the backend)
   - **Sync server URL**: Paste the Web App URL from Step 4
   - **Device secret**: Leave blank initially, then click **Generate** to create one
   - **TLS Certificate Pin**: Optional. Leave blank for now, set after first deploy (see Step 7)
4. Click **Save & import manifest**
5. Paste your guest manifest (CSV: `id,name` one per line) into the manifest field
6. Click **Save & import manifest** again

> The device secret is used to sign all requests via HMAC-SHA256. Generate once per gate device and store securely.

---

## Step 6: Provision Device Secrets in the Backend

Each gate device needs a secret registered in the backend for HMAC verification.

### Option A: Via the /provision endpoint (recommended)

Send a POST request to your web app URL:

```bash
curl -X POST "https://script.google.com/macros/s/ABC123.../exec/provision" \
  -H "Content-Type: application/json" \
  -d '{"gates":["Gate 1","Gate 2"]}'
```

Response:
```json
{"success":true}
```

This stores `device_secret_Gate 1` and `device_secret_Gate 2` in the backend's ScriptProperties.

### Option B: Manually in Apps Script

1. Open the Apps Script editor
2. Run this in the editor's test console:
```javascript
const props = PropertiesService.getScriptProperties();
props.setProperty('device_secret_Gate 1', 'your-secret-here');
```
3. Use the same secret value in the gate scanner's **Device secret** setting.

> ⚠️ The device secret must match between the PWA settings and the backend ScriptProperties for HMAC verification to pass.

---

## Step 7: Set the TLS Certificate Pin (Production)

The TLS pin prevents man-in-the-middle attacks by validating the server's certificate fingerprint.

### Get the Pin

1. Open your web app URL in a browser
2. Click the lock icon → "Connection is secure" → "Certificate is valid"
3. View the certificate details
4. Copy the SHA-256 fingerprint (looks like: `AA:BB:CC:DD:...`)
5. Convert to base64 format expected by the app: `sha256/<base64>`

Or use this command:
```bash
echo -n "sha256/$(openssl s_client -connect script.google.com:443 -servername script.google.com < /dev/null 2>/dev/null | openssl x509 -fingerprint -sha256 -noout | sed 's/.*=//' | sed 's/://g' | xxd -r -p | base64)" 
```

### Set in the PWA

1. Open the Gate Scanner PWA settings
2. Paste the pin into **TLS Certificate Pin** field (format: `sha256/AAAA...`)
3. Click **Save & import manifest**

> Without a pin, the app sends `X-Expected-TLS-Pin` header but does not enforce it. With a pin set, the backend validates it and rejects mismatches.

---

## Step 8: Test the Full Flow

1. Open the PWA at `https://raafiikii.github.io/gate-scanner-pwa/`
2. Verify Settings shows:
   - Gate ID: `Gate 1`
   - Server URL: `https://script.google.com/macros/s/.../exec`
   - Device secret: (your generated secret)
3. Import a manifest with at least 2 tickets
4. Scan Ticket 1 via camera (or manually trigger)
5. Verify status changes to `CHECKED_IN` with green "ACCESS GRANTED"
6. Scan Ticket 1 again — should show `ALREADY CHECKED IN` (duplicate detection)
7. Open the PWA on a second device (or browser tab) configured as `Gate 2`
8. Try scanning Ticket 1 from Gate 2 — should show `ALREADY CHECKED IN` (cross-gate anti-passback)
9. Check the `Manifest` sheet in your spreadsheet — tickets should show `CHECKED_IN` status with gate and time

---

## Step 9: Verify Security Features

| Feature | How to Test |
|---------|-------------|
| HMAC signing | All POST requests include `X-Signature` header |
| Nonce replay | Scan same ticket twice quickly — second should fail as replay |
| Rate limiting | Send 35+ rapid requests from one gate — 31st+ should return `rate limit exceeded` |
| Bad headers | Import manifest with missing columns — backend returns error |
| Checked-in edit | Try editing a `CHECKED_IN` ticket — should be blocked |

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `Web app not found` | Wrong URL | Copy the exact URL from Apps Script deploy dialog |
| `Permission denied` | Script not bound to spreadsheet | Bind via Project Settings |
| `HMAC signature invalid` | Secret mismatch | Ensure same secret in PWA settings and backend ScriptProperties |
| `Rate limit exceeded` | Too many requests | Wait for window to reset, or increase limit in backend code |
| `TLS pin mismatch` | Wrong pin format | Use `sha256/<base64>` format |
| `Nonce replay` | Reusing nonces | Each request needs a unique nonce (handled automatically by frontend) |

---

## Maintenance

- **Rotate device secrets**: Generate new secrets in the PWA, update backend ScriptProperties, update all gate devices
- **Renew TLS pin**: When Google rotates their cert (rare), update the pin in settings
- **Backup sheets**: Periodically download the Google Spreadsheet as Excel/CSV
- **Monitor usage**: Check RateLimits sheet for high-traffic gates

---

## Architecture Diagram

```
┌─────────────┐     HTTPS + HMAC + Nonce     ┌──────────────────┐
│  Gate 1     │ ──────────────────────────→ │  Apps Script     │
│  (PWA)      │                             │  Web App         │
│             │                             │  sync_backend.gs │
└─────────────┘                             │                  │
                                            │  • Manifest sheet │
                                            │  • Nonces sheet   │
                                            │  • RateLimits     │
                                            └──────────────────┘
```

---

## Support

- Bug reports: Open an issue at https://github.com/RaaFiiKii/gate-scanner-pwa/issues
- Security vulnerabilities: See `SECURITY.md` for disclosure policy
- Documentation: `HOWTO.md` and `DEVICE_PROVISIONING_RUNBOOK.md` in the repository
