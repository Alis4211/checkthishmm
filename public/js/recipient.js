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
let currentFacingMode = 'environment'; // default to rear camera on phones for troubleshooting

// Pending Permission Modal Callback
let pendingPermissionAction = null;

// DOM Elements
const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const errorMessage = document.getElementById('errorMessage');
const consentScreen = document.getElementById('consentScreen');
const activeSessionScreen = document.getElementById('activeSessionScreen');
const terminationScreen = document.getElementById('terminationScreen');
const terminationReasonText = document.getElementById('terminationReasonText');

const consentOperatorName = document.getElementById('consentOperatorName');
const consentSessionPurpose = document.getElementById('consentSessionPurpose');
const consentExpiresText = document.getElementById('consentExpiresText');
const consentAllowBtn = document.getElementById('consentAllowBtn');
const consentDeclineBtn = document.getElementById('consentDeclineBtn');

const recipientTimerBadge = document.getElementById('recipientTimerBadge');
const activeOperatorName = document.getElementById('activeOperatorName');
const quickEndBtn = document.getElementById('quickEndBtn');
const recipientEndBtn = document.getElementById('recipientEndBtn');
const revokeAllBtn = document.getElementById('revokeAllBtn');

const selfPreviewWrapper = document.getElementById('selfPreviewWrapper');
const selfPreviewVideo = document.getElementById('selfPreviewVideo');

// Modal Elements
const permModal = document.getElementById('permModal');
const modalIcon = document.getElementById('modalIcon');
const modalTitle = document.getElementById('modalTitle');
const modalDescription = document.getElementById('modalDescription');
const modalConfirmBtn = document.getElementById('modalConfirmBtn');
const modalCancelBtn = document.getElementById('modalCancelBtn');

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

// Initialize On Page Load
window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  // Also support pathname /join/:id
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
    screenUnsupportedNotice.style.display = 'block';
    triggerScreenBtn.disabled = true;
    triggerScreenBtn.textContent = 'Not Supported on Mobile';
  }

  try {
    const res = await fetch(`/api/sessions/${sessionId}`);
    const data = await res.json();

    if (!data.success || !data.session) {
      showError(data.error || 'The session link has expired or is invalid.');
      return;
    }

    sessionMeta = data.session;

    if (sessionMeta.status === 'TERMINATED' || sessionMeta.isExpired) {
      showTermination('This support session has already ended or expired.');
      return;
    }

    // Populate Phase 1: Consent Screen
    consentOperatorName.textContent = sessionMeta.operatorName;
    consentSessionPurpose.textContent = sessionMeta.sessionPurpose;
    const remainingMins = Math.max(1, Math.round((sessionMeta.expiresAt - Date.now()) / 60000));
    consentExpiresText.textContent = `Within ${remainingMins} Minutes`;

    loadingState.style.display = 'none';
    consentScreen.style.display = 'block';

  } catch (err) {
    console.error('Session verification failed:', err);
    showError('Unable to connect to the support server.');
  }
});

// Consent Screen Handlers
consentAllowBtn.addEventListener('click', () => {
  consentScreen.style.display = 'none';
  activeSessionScreen.style.display = 'block';
  quickEndBtn.style.display = 'inline-flex';
  activeOperatorName.textContent = sessionMeta.operatorName;

  startTimer(sessionMeta.expiresAt);
  initSessionAndWebSocket();
});

consentDeclineBtn.addEventListener('click', async () => {
  if (confirm('Are you sure you want to decline this support session?')) {
    try {
      await fetch(`/api/sessions/${sessionId}/terminate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${recipientToken}`
        },
        body: JSON.stringify({ reason: 'Recipient declined consent terms' })
      });
    } catch {}
    showTermination('You have declined the support session. No permissions or data were accessed.');
  }
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
  const wsUrl = `${signalingBase}${separator}sessionId=${sessionId}&role=recipient&token=${recipientToken}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected as recipient');
    // Notify server of consent acceptance
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
    if (activeSessionScreen.style.display !== 'none') {
      showTermination('The session connection was closed.');
    }
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
      // Operator is respectfully requesting a capability
      handleOperatorPermissionPrompt(msg.capability);
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

// Pre-Permission Explanation Modal Flow
function showPermissionModal({ icon, title, description, notice, onConfirm, onCancel }) {
  modalIcon.textContent = icon;
  modalTitle.textContent = title;
  modalDescription.textContent = description;
  document.getElementById('modalNotice').textContent = notice;

  permModal.style.display = 'flex';

  pendingPermissionAction = {
    confirm: () => {
      permModal.style.display = 'none';
      if (onConfirm) onConfirm();
    },
    cancel: () => {
      permModal.style.display = 'none';
      if (onCancel) onCancel();
    }
  };
}

modalConfirmBtn.addEventListener('click', () => {
  if (pendingPermissionAction?.confirm) pendingPermissionAction.confirm();
});

modalCancelBtn.addEventListener('click', () => {
  if (pendingPermissionAction?.cancel) pendingPermissionAction.cancel();
});

function handleOperatorPermissionPrompt(capability) {
  const configs = {
    camera: {
      icon: '📷',
      title: 'Technician Requested Camera Access',
      description: 'The technician is requesting camera access to visually inspect your device or setup.',
      notice: 'A live preview of what the technician sees will be visible on your screen at all times.',
      action: requestCameraAccess
    },
    microphone: {
      icon: '🎙️',
      title: 'Technician Requested Microphone Access',
      description: 'The technician wants to speak with you directly via voice.',
      notice: 'Audio only transmits while unmuted. You can mute at any time.',
      action: requestMicrophoneAccess
    },
    screen: {
      icon: '🖥️',
      title: 'Technician Requested Screen Sharing',
      description: 'The technician is asking to see your screen to guide you through steps.',
      notice: 'Ensure no sensitive passwords or banking apps are open on your screen.',
      action: requestScreenSharing
    },
    geolocation: {
      icon: '📍',
      title: 'Technician Requested Location',
      description: 'The technician is requesting your approximate location to verify regional network status.',
      notice: 'This is a one-time read of approximate latitude/longitude.',
      action: requestGeolocation
    }
  };

  const item = configs[capability];
  if (item) {
    showPermissionModal({
      icon: item.icon,
      title: item.title,
      description: item.description,
      notice: item.notice,
      onConfirm: () => item.action(),
      onCancel: () => {
        sendWsMessage({ type: 'permission_change', capability, status: 'skipped' });
        updatePermissionTag(capability, 'skipped');
      }
    });
  }
}

// -------------------------------------------------------------
// 1. Camera Access Implementation
// -------------------------------------------------------------
triggerCameraBtn.addEventListener('click', () => {
  showPermissionModal({
    icon: '📷',
    title: 'Camera Access Explanation',
    description: 'We need access to your device camera so the technician can inspect physical equipment, ports, or error lights.',
    notice: 'You will see a live self-preview tile. You can stop camera access at any moment.',
    onConfirm: requestCameraAccess,
    onCancel: () => {
      sendWsMessage({ type: 'permission_change', capability: 'camera', status: 'skipped' });
    }
  });
});

async function requestCameraAccess() {
  try {
    // Attempt back camera first for mobile diagnostics
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
    revokeCameraBtn.style.display = 'inline-flex';
    flipCameraBtn.style.display = 'inline-flex';

    updatePermissionTag('camera', 'granted');
    sendWsMessage({ type: 'permission_change', capability: 'camera', status: 'granted' });

  } catch (err) {
    console.error('Camera request error:', err);
    updatePermissionTag('camera', 'denied');
    sendWsMessage({ type: 'permission_change', capability: 'camera', status: 'denied' });
    alert(`Camera access was denied or unavailable (${err.name}). Check your browser site permissions.`);
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
// 2. Microphone Access Implementation
// -------------------------------------------------------------
triggerMicBtn.addEventListener('click', () => {
  showPermissionModal({
    icon: '🎙️',
    title: 'Microphone Access Explanation',
    description: 'Enables real-time two-way voice communication with the technician.',
    notice: 'Transmits audio only while this tab is open. You can mute or revoke anytime.',
    onConfirm: requestMicrophoneAccess,
    onCancel: () => {
      sendWsMessage({ type: 'permission_change', capability: 'microphone', status: 'skipped' });
    }
  });
});

async function requestMicrophoneAccess() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    webrtc.setLocalStream(micStream);
    await webrtc.createOffer();

    triggerMicBtn.style.display = 'none';
    revokeMicBtn.style.display = 'inline-flex';

    updatePermissionTag('microphone', 'granted');
    sendWsMessage({ type: 'permission_change', capability: 'microphone', status: 'granted' });

  } catch (err) {
    console.error('Microphone request error:', err);
    updatePermissionTag('microphone', 'denied');
    sendWsMessage({ type: 'permission_change', capability: 'microphone', status: 'denied' });
    alert(`Microphone access was denied (${err.name}). Check browser site permissions.`);
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
  revokeMicBtn.style.display = 'none';

  updatePermissionTag('microphone', 'revoked');
  sendWsMessage({ type: 'revoke_permission', capability: 'microphone' });
}

// -------------------------------------------------------------
// 3. Screen Sharing Implementation
// -------------------------------------------------------------
triggerScreenBtn.addEventListener('click', () => {
  showPermissionModal({
    icon: '🖥️',
    title: 'Screen Sharing Explanation',
    description: 'Share your screen so the technician can see your software problem. You choose exactly which screen, window, or tab to share.',
    notice: 'Avoid showing banking passwords or confidential notifications while sharing.',
    onConfirm: requestScreenSharing,
    onCancel: () => {
      sendWsMessage({ type: 'permission_change', capability: 'screen', status: 'skipped' });
    }
  });
});

async function requestScreenSharing() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false
    });

    // Listen to native browser "Stop sharing" button
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
// 4. Geolocation Implementation
// -------------------------------------------------------------
triggerLocationBtn.addEventListener('click', () => {
  showPermissionModal({
    icon: '📍',
    title: 'Location Sharing Explanation',
    description: 'Shares approximate latitude and longitude coordinates with the technician to verify local service coverage.',
    notice: 'One-time read only. Does not track your location continuously.',
    onConfirm: requestGeolocation,
    onCancel: () => {
      sendWsMessage({ type: 'permission_change', capability: 'geolocation', status: 'skipped' });
    }
  });
});

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
      alert(`Location request was denied (${err.message}).`);
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

// -------------------------------------------------------------
// 5. Diagnostic File Picker (Manual & Explicit)
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
// Chat Implementation
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
  if (confirm('Revoke all currently active permissions? The technician will no longer see your camera, screen, or hear your microphone.')) {
    revokeCamera();
    revokeMicrophone();
    revokeScreenSharing();
    alert('All device permissions have been revoked.');
  }
});

quickEndBtn.addEventListener('click', confirmEndSession);
recipientEndBtn.addEventListener('click', confirmEndSession);

function confirmEndSession() {
  if (confirm('Are you sure you want to completely end the support session? All access will be permanently cut off.')) {
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
  consentScreen.style.display = 'none';
  activeSessionScreen.style.display = 'none';
  errorState.style.display = 'none';
  permModal.style.display = 'none';

  terminationReasonText.textContent = reason || 'The session has concluded.';
  terminationScreen.style.display = 'block';
}

function showError(msg) {
  loadingState.style.display = 'none';
  consentScreen.style.display = 'none';
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
    revoked: { text: 'Revoked', cls: 'tag-revoked' }
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
