# Consent-Based Remote Support Web Application

A production-quality, privacy-first remote technical support web application built with standard Web APIs (WebRTC, `getUserMedia`, `getDisplayMedia`, Geolocation, and HTML5 File API).

This application adheres to strict browser security policies:
- **Zero Stealth Access**: All device capabilities require explicit user review and individual browser prompts.
- **Zero Protected OS Access**: By architecture, it cannot access contacts, SMS, call history, passwords, cookies, or control the remote operating system.
- **No Automatic Recording**: Media is streamed peer-to-peer or in memory; no audio, video, or screen sharing is persisted to disk without separate, explicit recording consent.
- **Immediate Revocation**: The recipient can revoke individual permissions or terminate the entire session at any time with a single tap.

---

## Key Features

### 1. Operator Console (`/operator.html`)
- **Session Generator**: Generates cryptographically secure, single-use session tokens (`crypto.randomBytes(32)`).
- **Dynamic QR Code**: Automatically renders high-contrast QR codes for easy mobile phone camera scanning.
- **Real-Time Video Monitor**: Receives remote camera or screen share streams with fullscreen support.
- **Audio Equalizer Visualizer**: Web Audio API `AnalyserNode` frequency spectrum meter showing live microphone activity.
- **Live Permission Matrix**: Tracks whether Camera, Microphone, Screen, Location, or Files are `Not Requested`, `Pending`, `Granted`, `Denied`, or `Revoked`.
- **Operator Prompt Trigger**: Operator can send a polite prompt requesting the customer to consider a specific permission.
- **Immutable Audit Trail**: Chronological event timeline recording every session lifecycle and permission transition.
- **Instant Emergency Termination**: Cuts connection, destroys peer connection, and revokes all tokens.

### 2. Recipient Mobile-First Interface (`/session.html?id=...&token=...`)
- **Phase 1: Transparent Consent Screen**:
  - Highlights technician name and stated purpose.
  - Expiration countdown timer.
  - Side-by-side comparison: **What May Be Requested** vs. **What Will NEVER Be Accessed**.
  - **Allow & Continue** vs. **Decline & Exit** buttons.
- **Phase 2: Granular Permission Controls**:
  - Pre-permission explanation modals before each browser prompt.
  - Flip Camera toggle (rear camera default for hardware/cable troubleshooting, front camera for face-to-face).
  - Live self-preview tile: recipient always sees exactly what the operator is viewing.
  - One-time Geolocation verification.
  - Explicit diagnostic file selector (`<input type="file">`) for error logs or screenshots.
  - Interactive chat channel with technician.
  - Instant "Revoke All Permissions" and "End Session" buttons.
- **Phase 3: Security Termination Screen**:
  - Confirms media hardware shutoff, track cleanup, and token invalidation.

---

## Security Architecture

| Security Control | Implementation |
| :--- | :--- |
| **Session Isolation** | Separate 256-bit cryptographic tokens for operator control vs. recipient invitation |
| **Token Timing Protection** | `crypto.timingSafeEqual` prevents timing attacks on token validation |
| **Content Security Policy** | Strict Helmet CSP enforcing `default-src 'self'`, `frame-ancestors 'none'`, and restricted connect domains |
| **Rate Limiting** | `express-rate-limit` prevents session flooding and denial of service |
| **Session Expiration** | Configurable TTL (15m, 30m, 60m) with automatic background garbage collection |
| **Data Sanitation** | Public session metadata endpoints never expose operator tokens |

---

## Getting Started

### Prerequisites
- Node.js v18 or higher (v22 recommended)
- Modern web browser (Chrome, Edge, Safari, Firefox)

### Installation
```bash
npm install
```

### Running Locally (HTTP)
```bash
npm start
```
- Open Operator Console: `http://localhost:3000/operator.html`
- Create a session, copy the generated link or open in an incognito window to simulate the recipient.

### Running for Mobile Testing over LAN (HTTPS)
> [!IMPORTANT]
> Mobile browsers (iOS Safari, Android Chrome) require a **Secure Context (HTTPS)** to allow camera, microphone, and geolocation access over local Wi-Fi.
>
> Run the server with:
```bash
npm run start:https
```
1. The server will auto-generate ephemeral self-signed SSL certificates.
2. Note the Network/LAN IP displayed in the console (e.g., `https://192.168.1.50:3000`).
3. Open the Operator Console on your PC: `https://localhost:3000/operator.html`.
4. Scan the QR code using your smartphone connected to the same Wi-Fi.
5. Accept the browser's local self-signed certificate warning on your phone to test genuine mobile permissions.

---

## Automated Tests
Run the comprehensive test suite:
```bash
npm test
```
The test suite validates:
1. `SessionManager` state machine and token safety.
2. REST API endpoints, rate limiting, and Helmet CSP headers.
3. WebSocket signaling, role authentication, and real-time permission sync.
