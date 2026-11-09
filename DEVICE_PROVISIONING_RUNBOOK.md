# Device Provisioning Runbook — Gate Scanner

**Version:** 1.0  
**Classification:** Internal — Operational  
**Owner:** Platform Engineering

---

## Overview

This runbook covers the complete lifecycle of provisioning a gate device for the Gate Scanner platform. Each device requires:

1. **Hardware setup** — Tablet + camera + power
2. **Software install** — PWA install + configuration
3. **Identity provisioning** — HMAC secret + TLS pin
4. **Verification** — End-to-end test scan

---

## Prerequisites

| Item | Specification |
|------|---------------|
| **Hardware** | iOS 15+ / Android 10+, 2GB RAM, 720p camera |
| **Network** | Dedicated WiFi + cellular fallback |
| **Power** | 8hr battery or continuous charging |
| **Accounts** | Google account for Sheet access, Cloudflare for edge |

---

## Step 1: Google Sheet Setup (One-Time per Event)

### 1.1 Create Manifest Sheet
1. Open Google Sheets → New spreadsheet
2. Name first tab: `Manifest`
3. Row 1 headers (exact, case-sensitive):
   ```
   id | name | status | gate | time | version
   ```
4. Populate guest list (one row per ticket):
   ```
   TKT-1001-A,Alex Tan,,,
   TKT-1001-B,Alex Tan,,,
   TKT-5582-A,Chloe Lim,,,
   ```

### 1.2 Deploy Apps Script Backend
1. In Sheet: Extensions → Apps Script
2. Delete default code, paste `sync_backend.gs`
3. Save (Ctrl+S), name project "Gate Scanner Sync"
4. Deploy → New deployment → Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy deployment URL (ends in `/exec`)

### 1.3 Create Supporting Tabs (Auto-Created)
The backend auto-creates these tabs on first run:
- `Nonces` — Replay protection (nonce, gate, timestamp)
- `RateLimits` — Rate limiting (gate, window_start, count)

---

## Step 2: Device Provisioning (Per Gate Device)

### 2.1 Hardware Setup
```
[Tablet] ←→ [Charger] ←→ [Power]
   ↓
[Camera] → QR scanning
   ↓
[WiFi] → Dedicated SSID + Cellular backup
```

### 2.2 Install PWA
1. Open Chrome/Safari on tablet
2. Navigate to scanner URL (static host, e.g., `https://scanner.example.com`)
3. **iOS:** Share → Add to Home Screen
4. **Android:** Menu → Install app / Add to Home Screen
5. Verify: App opens fullscreen, no browser chrome

### 2.3 Configure Device Identity

#### Generate HMAC Secret
1. Open scanner app → Settings & manifest import
2. Click **Generate** next to "Device secret"
3. **CRITICAL:** Copy secret immediately (shown once)
4. Store in password manager: `gate-scanner/gate-N/secret`

#### Provision in Backend (Apps Script Console)
```javascript
// Run once per device in Apps Script editor
function provisionDevice() {
  const secret = provisionDeviceSecret_('Gate 1');
  console.log('Gate 1 secret:', secret);
  // Copy output to password manager
}
provisionDevice();
```
- Replace `'Gate 1'` with actual gate ID (e.g., `'Main Entrance'`, `'VIP Gate'`)
- Run once per device
- Secret stored in ScriptProperties (encrypted at rest)

#### Configure TLS Certificate Pin (After First Deploy)
1. Deploy Cloudflare Worker / edge with certificate
2. Get SHA-256 fingerprint:
   ```bash
   openssl s_client -connect scanner.example.com:443 -servername scanner.example.com </dev/null \
     2>/dev/null | openssl x509 -fingerprint -sha256 -noout | sed 's/.*=//;s/://g' | tr '[:upper:]' '[:lower:]'
   ```
3. Format: `sha256/<lowercase-hex-no-colons>`
4. In scanner Settings: Paste pin → Click **Test Pin**

---

## Step 3: Manifest Import & Configuration

### 3.1 Enter Settings
| Field | Value | Example |
|-------|-------|---------|
| Gate ID | Unique per device | `Gate 1`, `VIP Gate`, `Main Entrance` |
| Sync Server URL | Apps Script `/exec` URL | `https://script.google.com/macros/s/AKfycb.../exec` |
| Device Secret | HMAC secret (32+ chars) | `a1b2c3d4e5f6...` |
| TLS Pin | SHA-256 fingerprint | `sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=` |
| Guest Manifest | CSV (id,name per line) | `TKT-1001-A,Alex Tan` |

### 3.2 Save & Import
1. Click **Save & import manifest**
2. Verify: "X new ticket(s) imported" toast
3. Check badge: "Gate: Gate 1" + "Checked in: 0"

---

## Step 4: End-to-End Verification

### 4.1 Test Scan (Online)
1. Generate test QR: `TKT-1001-A`
2. Scan with device camera
3. Verify: **ACCESS GRANTED** + "Welcome, Alex Tan!"
4. Check second scan: **ALREADY CHECKED IN** + original gate/time

### 4.2 Test Cross-Gate Anti-Passback
1. Scan same ticket at Gate 2
2. Verify: **ALREADY CHECKED IN** + "Entered via Gate 1 at [time]"

### 4.3 Test Offline Mode
1. Disable WiFi/cellular
3. Scan valid ticket
4. Verify: **ACCESS GRANTED** + "Saved locally"
5. Re-enable network → click **Sync now**
6. Verify: "Sync complete" + manifest reconciled

### 4.4 Test Security Features
| Test | Expected |
|------|----------|
| Replay same payload | `replay detected` |
| Missing nonce | `missing nonce` |
| Invalid HMAC | `invalid signature` |
| Rate limit (31 req/min) | `rate limit exceeded` |
| Invalid TLS pin | Connection fails at edge |

---

## Step 5: Day-of Operations

### 5.1 Pre-Event Checklist (Per Device)
- [ ] Battery > 80% or charging
- [ ] Camera clean, autofocus working
- [ ] Network connected (WiFi + cellular bars)
- [ ] Settings show correct Gate ID + Server URL
- [ ] Device secret loaded (Settings shows ••••••)
- [ ] TLS pin shows "Edge pinning active" (if configured)
- [ ] Manifest count matches expected

### 5.2 Staff Briefing
- **MANUAL CHECK-IN REQUIRED** = Server error → verify from main Sheet
- **ALREADY CHECKED IN** = Duplicate → check original gate/time
- **INVALID TICKET** = Not in manifest → deny entry
- **Sync now** button = Manual sync trigger

### 5.3 Monitoring
- Watch "Pending sync" badge (should be 0)
- Periodic **Sync now** click (every 30 min)
- Check Sheet `Manifest` tab for real-time status

---

## Step 6: Incident Response

| Issue | Action |
|-------|--------|
| **Device offline** | Check network → restart app → manual sync when back |
| **Server error** | Apps Script logs → check quota/lock → redeploy if needed |
| **Secret compromised** | `revokeDeviceSecret_('Gate N')` → generate new |
| **TLS pin mismatch** | Check Cloudflare cert → update pin in Settings |
| **Rate limited** | Wait 60s → check for runaway device |

---

## Step 7: Post-Event Deprovisioning

### 7.1 Data Export
1. Open Sheet → `Manifest` tab → File → Download → CSV
2. Archive with event metadata

### 7.2 Device Cleanup
1. Each device: Settings → **Reset database** → Confirm
2. Verify: "All local data cleared" + count = 0

### 7.3 Secret Rotation
```javascript
// Run in Apps Script console
function rotateSecrets() {
  const gates = ['Gate 1', 'Gate 2', 'Gate 3'];
  gates.forEach(g => {
    revokeDeviceSecret_(g);
    const newSecret = provisionDeviceSecret_(g);
    console.log(g, newSecret);
  });
}
rotateSecrets();
```
3. Distribute new secrets to devices

### 7.4 Secret Revocation (Compromise)
```javascript
revokeDeviceSecret_('Gate 1'); // Immediate revocation
```

---

## Appendix: Apps Script Admin Functions

| Function | Purpose |
|----------|---------|
| `provisionDeviceSecret_('Gate N')` | Generate + store secret |
| `listDeviceSecrets_()` | List all provisioned gates |
| `revokeDeviceSecret_('Gate N')` | Revoke secret (immediate) |
| `checkAndStoreNonce_(nonce, gate)` | Manual nonce check |
| `checkRateLimit_(gateId)` | Manual rate limit check |

---

## Security Notes

- **Secrets never leave device + ScriptProperties** (encrypted at rest)
- **Nonces expire after 5 min** (auto-cleanup)
- **Rate limit: 30 req/min per gate** (configurable in code)
- **TLS pin enforced at Cloudflare edge** (not in browser)
- **Audit trail:** Sheet `Manifest` + `Nonces` + `RateLimits` tabs

---

## Escalation Contacts

| Role | Contact | SLA |
|------|---------|-----|
| Platform Engineer | — | 15 min |
| Apps Script Owner | — | 30 min |
| Cloudflare Admin | — | 15 min |
| On-call (Day-of) | — | 5 min |

---

*End of Runbook*