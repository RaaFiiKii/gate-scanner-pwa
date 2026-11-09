# Gate Scanner — E2E Mock Test: How to Open & Run

Two depths of mock E2E, both in `C solution/`. No network required; no real Apps Script or camera.

## Prerequisites

```
node  (v18+)           — /opt/homebrew/bin/node
puppeteer-core        — already installed (node_modules/puppeteer-core) for Phase B
Chrome binary         — cached at /Users/raphael/.cache/puppeteer (gs_e2e.mjs uses it)
```

## Phase A — fast logic regression (no deps)

```
cd "C solution"
node gs_sim.mjs
```

Re-implements the patched branches in Node. Prints PASS/FAIL per scenario, exits non-zero on any failure.

Scenarios: S1 happy check-in · S2 same-gate duplicate · S3 cross-gate anti-passback (keeps first gate) · S4 offline replay + reconcile · S5 invalid · S6 header-mismatch hard error · S7 server-busy fast-fail · B5 import-count accuracy.

## Phase B — real-program integration (Puppeteer)

### 1. Serve the scanner

```
cd "C solution"
npx serve -l 8765 --no-request-logging
# or: node -e "const h=require('http'),f=require('fs');h.createServer((q,r)=>{const p=q.url==='/'?'/gate_scanner.html':q.url;const c=__dirname+p;r.writeHead(200,{'Content-Type':p.endsWith('.html')?'text/html':'text/plain'});r.end(f.readFileSync(c));}).listen(8765)" &
```

### 2. Run the harness

```
cd "C solution"
node gs_e2e.mjs
```

`gs_e2e.mjs` starts a second server on port 8931 (the sync backend bridge), opens `gate_scanner.html` in headless Chrome (port 8765), stubs the camera/Html5Qrcode before load, and routes every `fetch` to the real `doPost` via `gs-shim.mjs` (which runs the actual `sync_backend.gs` functions against an in-memory Sheet).

B2 scenarios: B-I manifest import + scan · ACCESS GRANTED · duplicate re-scan · cross-gate duplicate under lock · invalid ticket · server-busy fast-fail · accurate import count with skipped lines.

## Files

```
gate_scanner.html   — the scanner (real DOM, real IndexedDB, real fetch)
sync_backend.gs     — the backend (runs verbatim through the shim)
gs_sim.mjs          — Phase A harness (logic re-implementation)
gs-shim.mjs         — Phase B1 shim (Apps Script runtime in Node)
gs_e2e.mjs          — Phase B2 harness (Puppeteer + HTTP bridge)
HOWTO.md            — this guide
```

## What "opening the platform" means

Phase A is a terminal test (Node). Phase B is headless — it drives the real page but has no display. To **watch** the scanner UI respond, temporarily comment out the Html5Qrcode stub in `gs_e2e.mjs`'s `evaluateOnNewDocument` (let the camera reject naturally) and enlarge the headless window: add `await page.setViewport({width:480,height:800});` right after `browser.newPage()`. Then `gs_e2e.mjs` will show the actual status panel updates as it runs.
