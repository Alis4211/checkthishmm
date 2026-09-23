import assert from 'assert';
import http from 'http';
import { createApp } from '../server/app.js';
import { setupSignaling } from '../server/signaling.js';
import { sessionManager, SessionManager } from '../server/sessionManager.js';
import { WebSocket } from 'ws';

async function runTests() {
  console.log('🧪 Starting Test Suite: Consent-Based Remote Support App...\n');

  // ------------------------------------------------------------------------
  // Test 1: SessionManager Unit Tests
  // ------------------------------------------------------------------------
  console.log('Test 1: SessionManager Lifecycle & Cryptographic Tokens');
  const sm = new SessionManager();
  const session = sm.createSession({
    operatorName: 'Alex Tech',
    sessionPurpose: 'Router Cable Check',
    durationMinutes: 15
  });

  assert.ok(session.id, 'Session ID must exist');
  assert.equal(session.id.length, 32, 'Session ID should be 32 hex chars');
  assert.ok(session.operatorToken, 'Operator token must exist');
  assert.ok(session.recipientToken, 'Recipient token must exist');
  assert.notEqual(session.operatorToken, session.recipientToken, 'Tokens must be distinct');
  assert.equal(session.status, 'CREATED', 'Initial state should be CREATED');

  // Token Validation
  assert.strictEqual(sm.validateOperator(session.id, session.operatorToken), true, 'Valid operator token matches');
  assert.strictEqual(sm.validateOperator(session.id, 'invalid-token-1234'), false, 'Invalid operator token fails');
  assert.strictEqual(sm.validateRecipient(session.id, session.recipientToken), true, 'Valid recipient token matches');
  assert.strictEqual(sm.validateRecipient(session.id, session.operatorToken), false, 'Operator token rejected as recipient token');

  // Public Info Sanitization
  const publicInfo = sm.getPublicSessionInfo(session.id);
  assert.strictEqual(publicInfo.id, session.id);
  assert.strictEqual(publicInfo.operatorName, 'Alex Tech');
  assert.strictEqual(publicInfo.operatorToken, undefined, 'Public info must NEVER leak operatorToken');
  assert.strictEqual(publicInfo.recipientToken, undefined, 'Public info must NEVER leak recipientToken');

  // Consent Acceptance
  sm.recordConsent(session.id, true);
  assert.equal(sm.getSession(session.id).status, 'ACTIVE', 'Session should become ACTIVE on consent');

  // Permission Transitions
  sm.updatePermission(session.id, 'camera', 'granted', 'recipient');
  assert.equal(sm.getSession(session.id).permissions.camera, 'granted', 'Camera permission granted');

  sm.updatePermission(session.id, 'camera', 'revoked', 'recipient');
  assert.equal(sm.getSession(session.id).permissions.camera, 'revoked', 'Camera permission revoked');

  // Geolocation storage
  sm.storeLocation(session.id, { latitude: 37.7749, longitude: -122.4194, accuracy: 15 });
  assert.equal(sm.getSession(session.id).location.latitude, 37.7749);

  // Termination
  sm.terminateSession(session.id, 'Test completion', 'operator');
  assert.equal(sm.getSession(session.id).status, 'TERMINATED');
  assert.equal(sm.getSession(session.id).permissions.camera, 'revoked');
  sm.destroy();
  console.log('✓ Test 1 passed!\n');

  // ------------------------------------------------------------------------
  // Test 2: HTTP Server & REST API Endpoints
  // ------------------------------------------------------------------------
  console.log('Test 2: REST API Endpoints & Security Headers');
  const app = createApp();
  const server = http.createServer(app);
  const signaling = setupSignaling(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 2a: POST /api/sessions
  const createRes = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operatorName: 'Jane Specialist',
      sessionPurpose: 'Audio issue troubleshooting',
      durationMinutes: 20
    })
  });

  assert.equal(createRes.status, 201, 'Session creation returned 201');
  const createData = await createRes.json();
  assert.ok(createData.success);
  assert.ok(createData.session.qrCodeDataUrl.startsWith('data:image/png;base64,'), 'QR code data URL generated');

  const testSessionId = createData.session.id;
  const testOpToken = createData.session.operatorToken;
  const testRecipToken = createData.session.recipientToken;

  // Verify CSP Header
  const cspHeader = createRes.headers.get('content-security-policy');
  assert.ok(cspHeader, 'Content-Security-Policy header present');
  assert.ok(cspHeader.includes("default-src 'self'"), 'CSP includes default-src');

  // 2b: GET /api/sessions/:id (Public metadata)
  const getPubRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}`);
  assert.equal(getPubRes.status, 200);
  const pubData = await getPubRes.json();
  assert.equal(pubData.session.operatorName, 'Jane Specialist');
  assert.strictEqual(pubData.session.operatorToken, undefined, 'No operator token leaked in public endpoint');

  // 2c: GET /api/sessions/:id/operator (Requires Operator Auth)
  const unauthOpRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/operator`);
  assert.equal(unauthOpRes.status, 401, 'Unauthorized request rejected');

  const authOpRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/operator`, {
    headers: { 'Authorization': `Bearer ${testOpToken}` }
  });
  assert.equal(authOpRes.status, 200, 'Authorized operator accepted');
  const opData = await authOpRes.json();
  assert.ok(Array.isArray(opData.session.auditLog), 'Audit log returned to operator');

  // 2d: POST /api/sessions/:id/terminate
  const termRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}/terminate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${testRecipToken}`
    },
    body: JSON.stringify({ reason: 'Recipient ended test' })
  });
  assert.equal(termRes.status, 200);

  // Check state now terminated
  const getTermRes = await fetch(`${baseUrl}/api/sessions/${testSessionId}`);
  const termData = await getTermRes.json();
  assert.equal(termData.session.status, 'TERMINATED');

  console.log('✓ Test 2 passed!\n');

  // ------------------------------------------------------------------------
  // Test 3: WebSocket Signaling & Role Authentication
  // ------------------------------------------------------------------------
  console.log('Test 3: WebSocket Authentication & Signaling Exchange');
  // Create a fresh session for WebSocket test
  const wsSession = sessionManager.createSession({
    operatorName: 'Senior Eng',
    sessionPurpose: 'WebRTC Signaling Test'
  });

  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  // 3a: Unauthorized connection (missing token) should close
  await new Promise((resolve) => {
    const badWs = new WebSocket(`${wsUrl}?sessionId=${wsSession.id}&role=operator&token=wrong`);
    badWs.on('close', (code) => {
      assert.equal(code, 4401, 'Bad token closed with 4401');
      resolve();
    });
  });

  // 3b: Valid Operator & Recipient Handshake
  const operatorWs = new WebSocket(`${wsUrl}?sessionId=${wsSession.id}&role=operator&token=${wsSession.operatorToken}`);
  const recipientWs = new WebSocket(`${wsUrl}?sessionId=${wsSession.id}&role=recipient&token=${wsSession.recipientToken}`);

  await Promise.all([
    new Promise(res => operatorWs.on('open', res)),
    new Promise(res => recipientWs.on('open', res))
  ]);

  // Recipient sends consent acceptance
  recipientWs.send(JSON.stringify({ type: 'consent_decision', accepted: true }));

  // Operator receives consent notification
  await new Promise((resolve) => {
    operatorWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'consent_updated' && msg.accepted === true) {
        resolve();
      }
    });
  });

  // Recipient grants camera
  recipientWs.send(JSON.stringify({
    type: 'permission_change',
    capability: 'camera',
    status: 'granted'
  }));

  // Operator receives permission notification
  await new Promise((resolve) => {
    operatorWs.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'permission_updated' && msg.capability === 'camera' && msg.status === 'granted') {
        resolve();
      }
    });
  });

  // Cleanup
  operatorWs.close();
  recipientWs.close();
  server.close();
  console.log('✓ Test 3 passed!\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY! The application meets all architectural and security requirements.');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test failed with error:', err);
  process.exit(1);
});
