# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9   | :x:                |

## Reporting a Vulnerability

We take the security of the Gate Scanner PWA seriously. If you discover a security vulnerability, please report it to us responsibly.

### How to Report

1. **Do not** create a public GitHub issue for security vulnerabilities.
2. Email the maintainer at security@your-domain.org (or open a private advisory via GitHub).
3. Include the following details:
   - Description of the vulnerability
   - Steps to reproduce
   - Affected components (frontend, backend, or both)
   - Potential impact
   - Suggested fix (if any)

### What to Expect

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Resolution**: Depends on severity; we aim to patch critical issues within 7 days

### Severity Classification

| Severity | Definition | Target Resolution |
|----------|-----------|-------------------|
| Critical | Remote code execution, data exfiltration, authentication bypass | 7 days |
| High | Privilege escalation, XSS, CSRF, broken access control | 14 days |
| Medium | Information disclosure, rate limiting bypass, weak crypto | 30 days |
| Low | Minor information leakage, best practice violations | 60 days |

### Scope

In scope:
- `gate_scanner.html` — frontend PWA
- `sync_backend.gs` — Google Apps Script backend
- `gs-shim.mjs` — Node test shim
- HTTP/S communication between frontend and backend

Out of scope:
- User's local device security
- Google account compromise
- Network infrastructure outside our control

### Recognition

Security researchers who responsibly disclose vulnerabilities will be:
- Listed in our security acknowledgments (with permission)
- Credited in release notes for the fix

### Safe Harbor

We will not pursue legal action against researchers who:
- Act in good faith
- Do not access or exfiltrate real user data
- Do not degrade service quality
- Follow this disclosure policy

## Security Features

The Gate Scanner PWA implements the following security controls:

- **TLS Certificate Pinning** — SHA-256 fingerprint validation
- **HMAC-SHA256 Request Signing** — Per-device secrets
- **Nonce/Replay Protection** — 16-byte nonce, 5-minute TTL, Nonces sheet
- **Rate Limiting** — 30 req/min per gate, RateLimits sheet
- **Audit Integrity Mode** — Server errors reject scan, no offline fallback
- **Audit Log Signing** — Merkle tree for tamper-evident audit trail
- **Device Attestation** — WebAuthn/FIDO2 hardware-bound keys (optional)

## Disclosure Timeline

1. Researcher submits report
2. Maintainer acknowledges within 48 hours
3. Maintainer investigates and confirms
4. Fix developed and tested
5. Coordinated public disclosure after fix is deployed
