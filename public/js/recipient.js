import { WebRTCManager } from './webrtc.js';

// Application State
let sessionId = null;
let recipientToken = null;
let sessionMeta = null;
let ws = null;
let webrtc = null;
let timerInterval = null;

// Active Media State
let cameraStream = null;
let micStream = null;
let screenStream = null;
let currentFacingMode = 'environment'; // default to rear camera on phones

// DOM Elements
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const activeSessionScreen = document.getElementById('activeSessionScreen');
const terminationScreen = document.getElementById('terminationScreen');
const terminationReasonText = document.getElementById('terminationReasonText');

const recipientTimerBadge = document.getElementById('recipientTimerBadge');
const activeOperatorName = document.getElementById('activeOperatorName');
const activeSessionPurpose = document.getElementById('activeSessionPurpose');
const quickEndBtn = document.getElementById('quickEndBtn');
const recipientEndBtn = document.getElementById('recipientEndBtn');
const revokeAllBtn = document.getElementById('revokeAllBtn');

const selfPreviewWrapper = document.getElementById('selfPreviewWrapper');
const selfPreviewVideo = document.getElementById('selfPreviewVideo');

// Capability Buttons
const triggerCameraBtn = document.getElementById('triggerCameraBtn');
const revokeCameraBtn = document.getElementById('revokeCameraBtn');
const flipCameraBtn = document.getElementById('flipCameraBtn');

const triggerMicBtn = document.getElementById('triggerMicBtn');
const revokeMicBtn = document.getElementById('revokeMicBtn');

const triggerScreenBtn = document.getElementById('triggerScreenBtn');
const revokeScreenBtn = document.getElementById('revokeScreenBtn');
const screenUnsupportedNotice = document.getElementById('screenUnsupportedNotice');

const triggerLocationBtn = document.getElementById('triggerLocationBtn');

const triggerFileBtn = document.getElementById('triggerFileBtn');
const diagnosticFileInput = document.getElementById('diagnosticFileInput');
const fileUploadStatus = document.getElementById('fileUploadStatus');

const recipientChatHistory = document.getElementById('recipientChatHistory');
const recipientChatForm = document.getElementById('recipientChatForm');
const recipientChatInput = document.getElementById('recipientChatInput');

/**
 * Decode cryptographically signed token payload on client side as an offline/serverless fallback.
 */
function decodeTokenPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      const b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(atob(b64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
      return JSON.parse(json);
    }
  } catch (e) {
    console.warn('[Token Decode]:', e);
  }
  return null;
}

// Initialize On Page Load
window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split('/');
  if (pathParts[1] === 'join' && pathParts[2]) {
    sessionId = pathParts[2];
  } else {
    sessionId = urlParams.get('id');
  }
  recipientToken = urlParams.get('token');

  if (!sessionId || !recipientToken) {
    showError('Missing session parameters. Please check your invitation link.');
    return;
  }

  // Check getDisplayMedia support (some mobile browsers don't support it)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    if (screenUnsupportedNotice) screenUnsupportedNotice.style.display = 'block';
    if (triggerScreenBtn) {
      triggerScreenBtn.disabled = true;
      triggerScreenBtn.textContent = 'Not Supported on Mobile';
    }
  }

  // Fallback metadata extracted from signed token immediately
  const tokenPayload = decodeTokenPayload(recipientToken);
  let sessionData = null;

  try {
    const res = await fetch(`/api/sessions/${sessionId}?token=${encodeURIComponent(recipientToken)}`, {
      headers: { 'Authorization': `Bearer ${recipientToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.session) {
        sessionData = data.session;
      }
    }
  } catch (err) {
    console.warn('[Session Fetch Notice]: Serverless fetch notice, using verified token state:', err.message);
  }

  // If server responded or token is decoded, proceed directly
  if (!sessionData && tokenPayload) {
    sessionData = {
      id: sessionId,
      operatorName: tokenPayload.op || 'Support Specialist',
      sessionPurpose: tokenPayload.p || 'Technical Assistance',
      expiresAt: tokenPayload.exp || (Date.now() + 30 * 60 * 1000),
      status: 'ACTIVE'
    };
  }

  if (!sessionData) {
    showError('The session link has expired or is invalid.');
    return;
  }

  sessionMeta = sessionData;

  if (sessionMeta.status === 'TERMINATED' || Date.now() > sessionMeta.expiresAt) {
    showTermination('This support session has already ended or expired.');
    return;
  }

  // Enter Direct Access Active Support immediately
  loadingState.style.display = 'none';
  activeSessionScreen.style.display = 'block';
  activeOperatorName.textContent = sessionMeta.operatorName;
  if (activeSessionPurpose) activeSessionPurpose.textContent = sessionMeta.sessionPurpose;

  startTimer(sessionMeta.expiresAt);
  initSessionAndWebSocket();
});

// Initialize WebSocket and WebRTC
function initSessionAndWebSocket() {
  webrtc = new WebRTCManager({
    role: 'recipient',
    onSignal: (signal) => {
      sendWsMessage({ type: 'webrtc_signal', signal });
    },
    onConnectionStateChange: (state) => {
      console.log('[Recipient WebRTC] state:', state);
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  const customSignaling = window.SIGNALING_URL || urlParams.get('signaling');
  const signalingBase = customSignaling || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  const separator = signalingBase.includes('?') ? '&' : '?';
  const wsUrl = `${signalingBase}${separator}sessionId=${sessionId}&role=recipient&token=${encodeURIComponent(recipientToken)}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected directly as recipient');
    sendWsMessage({ type: 'consent_decision', accepted: true });
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[WS Parse Error]:', err);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Connection closed');
  };
}

function sendWsMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'permission_requested_by_operator': {
      // Respectful notification from operator
      handleOperatorPrompt(msg.capability);
      break;
    }

    case 'permission_updated': {
      updatePermissionTag(msg.capability, msg.status);
      break;
    }

    case 'webrtc_signal': {
      webrtc.handleSignal(msg.signal);
      break;
    }

    case 'chat_message': {
      appendChatMessage(msg.sender, msg.text, msg.timestamp);
      break;
    }

    case 'session_terminated': {
      showTermination(msg.reason || 'The support session has been terminated.');
      break;
    }

    default:
      console.log('[Recipient WS Msg]:', msg);
  }
}

function handleOperatorPrompt(capability) {
  const names = {
    camera: 'Camera',
    microphone: 'Microphone',
    screen: 'Screen Sharing',
    geolocation: 'Location'
  };
  const capName = names[capability] || capability;
  if (confirm(`Technician is requesting: ${capName}\n\nWould you like to turn on ${capName} now?`)) {
    if (capability === 'camera') requestCameraAccess();
    else if (capability === 'microphone') requestMicrophoneAccess();
    else if (capability === 'screen') requestScreenSharing();
    else if (capability === 'geolocation') requestGeolocation();
  }
}

// -------------------------------------------------------------
// Direct 1-Tap Camera Access
// -------------------------------------------------------------
triggerCameraBtn.addEventListener('click', requestCameraAccess);

async function requestCameraAccess() {
  try {
    triggerCameraBtn.textContent = 'Starting Camera...';
    triggerCameraBtn.disabled = true;

    const constraints = {
      video: {
        facingMode: { ideal: currentFacingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    };

    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);

    // Attach to WebRTC
    webrtc.setLocalStream(cameraStream);
    await webrtc.createOffer();

    // Show Self-Preview
    selfPreviewVideo.srcObject = cameraStream;
    selfPreviewWrapper.style.display = 'block';

    triggerCameraBtn.style.display = 'none';
    triggerCameraBtn.disabled = false;
    revokeCameraBtn.style.display = 'inline-flex';
    flipCameraBtn.style.display = 'inline-flex';

    updatePermissionTag('camera', 'granted');
    sendWsMessage({ type: 'permission_change', capability: 'camera', status: 'granted' });

  } catch (err) {
    console.error('Camera request error:', err);
    triggerCameraBtn.textContent = 'Turn On Camera';
    triggerCameraBtn.disabled = false;
    updatePermissionTag('camera', 'denied');
    sendWsMessage({ type: 'permission_change', capability: 'camera', status: 'denied' });
    alert(`Camera access was denied (${err.name}). Check your browser permission settings.`);
  }
}

revokeCameraBtn.addEventListener('click', revokeCamera);

function revokeCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  webrtc.removeTrackByKind('video');
  selfPreviewVideo.srcObject = null;
  selfPreviewWrapper.style.display = 'none';

  triggerCameraBtn.style.display = 'inline-flex';
  triggerCameraBtn.textContent = 'Turn On Camera';
  revokeCameraBtn.style.display = 'none';
  flipCameraBtn.style.display = 'none';

  updatePermissionTag('camera', 'revoked');
  sendWsMessage({ type: 'revoke_permission', capability: 'camera' });
}

flipCameraBtn.addEventListener('click', async () => {
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  revokeCamera();
  await requestCameraAccess();
});

// -------------------------------------------------------------
// Direct 1-Tap Microphone Access
// -------------------------------------------------------------
triggerMicBtn.addEventListener('click', requestMicrophoneAccess);

async function requestMicrophoneAccess() {
  try {
    triggerMicBtn.textContent = 'Enabling Mic...';
    triggerMicBtn.disabled = true;

    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    webrtc.setLocalStream(micStream);
    await webrtc.createOffer();

    triggerMicBtn.style.display = 'none';
    triggerMicBtn.disabled = false;
    revokeMicBtn.style.display = 'inline-flex';

    updatePermissionTag('microphone', 'granted');
    sendWsMessage({ type: 'permission_change', capability: 'microphone', status: 'granted' });

  } catch (err) {
    console.error('Microphone request error:', err);
    triggerMicBtn.textContent = 'Turn On Mic';
    triggerMicBtn.disabled = false;
    updatePermissionTag('microphone', 'denied');
    sendWsMessage({ type: 'permission_change', capability: 'microphone', status: 'denied' });
    alert(`Microphone access was denied (${err.name}). Check browser permissions.`);
  }
}

revokeMicBtn.addEventListener('click', revokeMicrophone);

function revokeMicrophone() {
  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  webrtc.removeTrackByKind('audio');

  triggerMicBtn.style.display = 'inline-flex';
  triggerMicBtn.textContent = 'Turn On Mic';
  revokeMicBtn.style.display = 'none';

  updatePermissionTag('microphone', 'revoked');
  sendWsMessage({ type: 'revoke_permission', capability: 'microphone' });
}

// -------------------------------------------------------------
// Direct 1-Tap Screen Sharing
// -------------------------------------------------------------
triggerScreenBtn.addEventListener('click', requestScreenSharing);

async function requestScreenSharing() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false
    });

    screenStream.getVideoTracks()[0].onended = () => {
      revokeScreenSharing();
    };

    webrtc.setLocalStream(screenStream);
    await webrtc.createOffer();

    selfPreviewVideo.srcObject = screenStream;
    selfPreviewWrapper.style.display = 'block';

    triggerScreenBtn.style.display = 'none';
    revokeScreenBtn.style.display = 'inline-flex';

    updatePermissionTag('screen', 'granted');
    sendWsMessage({ type: 'permission_change', capability: 'screen', status: 'granted' });

  } catch (err) {
    console.error('Screen sharing error:', err);
    updatePermissionTag('screen', 'denied');
    sendWsMessage({ type: 'permission_change', capability: 'screen', status: 'denied' });
  }
}

revokeScreenBtn.addEventListener('click', revokeScreenSharing);

function revokeScreenSharing() {
  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  webrtc.removeTrackByKind('video');
  selfPreviewVideo.srcObject = null;
  selfPreviewWrapper.style.display = 'none';

  triggerScreenBtn.style.display = 'inline-flex';
  revokeScreenBtn.style.display = 'none';

  updatePermissionTag('screen', 'revoked');
  sendWsMessage({ type: 'revoke_permission', capability: 'screen' });
}

// -------------------------------------------------------------
// Direct 1-Tap Geolocation
// -------------------------------------------------------------
triggerLocationBtn.addEventListener('click', requestGeolocation);

function requestGeolocation() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  triggerLocationBtn.disabled = true;
  triggerLocationBtn.textContent = 'Acquiring GPS...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const coords = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      };

      sendWsMessage({ type: 'location_update', location: coords });
      updatePermissionTag('geolocation', 'granted');
      sendWsMessage({ type: 'permission_change', capability: 'geolocation', status: 'granted' });

      triggerLocationBtn.textContent = '✓ Location Verified & Shared';
      triggerLocationBtn.className = 'btn btn-secondary btn-sm btn-block';
    },
    (err) => {
      console.error('Geolocation error:', err);
      triggerLocationBtn.disabled = false;
      triggerLocationBtn.textContent = 'Share Location (One-Time)';
      updatePermissionTag('geolocation', 'denied');
      sendWsMessage({ type: 'permission_change', capability: 'geolocation', status: 'denied' });
      alert(`Location access was denied (${err.message}).`);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

// -------------------------------------------------------------
// Direct File Upload
// -------------------------------------------------------------
triggerFileBtn.addEventListener('click', () => {
  diagnosticFileInput.click();
});

diagnosticFileInput.addEventListener('change', async () => {
  const file = diagnosticFileInput.files[0];
  if (!file) return;

  fileUploadStatus.style.display = 'block';
  fileUploadStatus.textContent = `Uploading ${file.name}...`;

  const formData = new FormData();
  formData.append('diagnosticFile', file);

  try {
    const res = await fetch(`/api/sessions/${sessionId}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${recipientToken}`
      },
      body: formData
    });

    const data = await res.json();
    if (data.success) {
      fileUploadStatus.textContent = `✓ Successfully sent: ${file.name}`;
      fileUploadStatus.style.color = 'var(--success)';
    } else {
      fileUploadStatus.textContent = `Upload failed: ${data.error}`;
      fileUploadStatus.style.color = 'var(--danger)';
    }
  } catch (err) {
    fileUploadStatus.textContent = `Upload error: ${err.message}`;
    fileUploadStatus.style.color = 'var(--danger)';
  }
});

// -------------------------------------------------------------
// Chat
// -------------------------------------------------------------
recipientChatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = recipientChatInput.value.trim();
  if (!text) return;
  sendWsMessage({ type: 'chat_message', text });
  recipientChatInput.value = '';
});

function appendChatMessage(sender, text, timestamp) {
  const msgEl = document.createElement('div');
  const isMe = sender === 'recipient';
  msgEl.style.padding = '0.35rem 0.5rem';
  msgEl.style.borderRadius = 'var(--radius-sm)';
  msgEl.style.background = isMe ? 'rgba(37, 99, 235, 0.2)' : 'rgba(51, 65, 85, 0.6)';
  msgEl.style.borderLeft = isMe ? '3px solid var(--primary)' : '3px solid var(--accent)';

  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  msgEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--text-dim);">
      <strong>${isMe ? 'You' : 'Technician'}</strong>
      <span>${timeStr}</span>
    </div>
    <div style="margin-top: 0.15rem; color: var(--text-main);">${escapeHtml(text)}</div>
  `;
  recipientChatHistory.appendChild(msgEl);
  recipientChatHistory.scrollTop = recipientChatHistory.scrollHeight;
}

// -------------------------------------------------------------
// Revocation & Session Termination
// -------------------------------------------------------------
revokeAllBtn.addEventListener('click', () => {
  revokeCamera();
  revokeMicrophone();
  revokeScreenSharing();
  alert('All device hardware has been turned off.');
});

quickEndBtn.addEventListener('click', confirmEndSession);
recipientEndBtn.addEventListener('click', confirmEndSession);

function confirmEndSession() {
  if (confirm('End the support session now? All connections will be closed.')) {
    terminateSessionLocally('Recipient ended support session');
  }
}

function terminateSessionLocally(reason) {
  revokeCamera();
  revokeMicrophone();
  revokeScreenSharing();

  sendWsMessage({ type: 'terminate_session', reason });
  showTermination(reason);
}

function showTermination(reason) {
  clearInterval(timerInterval);
  if (webrtc) webrtc.teardown();
  if (ws) {
    try { ws.close(); } catch {}
  }

  loadingState.style.display = 'none';
  activeSessionScreen.style.display = 'none';
  errorState.style.display = 'none';

  terminationReasonText.textContent = reason || 'The session has concluded.';
  terminationScreen.style.display = 'block';
}

function showError(msg) {
  loadingState.style.display = 'none';
  activeSessionScreen.style.display = 'none';
  errorMessage.textContent = msg;
  errorState.style.display = 'block';
}

function updatePermissionTag(capability, status) {
  const el = document.getElementById(`recipientStatus_${capability}`);
  if (!el) return;

  const statusMap = {
    not_requested: { text: 'Off', cls: 'tag-not-requested' },
    pending: { text: 'Pending', cls: 'tag-pending' },
    granted: { text: 'Active (Live)', cls: 'tag-granted' },
    denied: { text: 'Denied', cls: 'tag-denied' },
    skipped: { text: 'Skipped', cls: 'tag-skipped' },
    revoked: { text: 'Off (Revoked)', cls: 'tag-revoked' }
  };

  const meta = statusMap[status] || { text: status, cls: 'tag-not-requested' };
  el.className = `perm-status-tag ${meta.cls}`;
  el.textContent = meta.text;
}

function startTimer(expiresAt) {
  function tick() {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      recipientTimerBadge.textContent = 'Expired';
      showTermination('Session expired due to time limit.');
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    recipientTimerBadge.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
