import { WebRTCManager } from './webrtc.js';

// Application State
let activeSession = null;
let ws = null;
let webrtc = null;
let audioContext = null;
let audioAnalyser = null;
let audioAnimationId = null;
let timerInterval = null;

// DOM Elements
const createSessionSection = document.getElementById('createSessionSection');
const activeDashboard = document.getElementById('activeDashboard');
const createSessionForm = document.getElementById('createSessionForm');
const sessionUrlDisplay = document.getElementById('sessionUrlDisplay');
const copyUrlBtn = document.getElementById('copyUrlBtn');
const qrCodeImage = document.getElementById('qrCodeImage');
const connectionStatusPill = document.getElementById('connectionStatusPill');
const connectionStatusText = document.getElementById('connectionStatusText');
const sessionTimerBadge = document.getElementById('sessionTimerBadge');
const sessionTimerText = document.getElementById('sessionTimerText');
const headerEndBtn = document.getElementById('headerEndBtn');
const mainEndBtn = document.getElementById('mainEndBtn');

const remoteVideo = document.getElementById('remoteVideo');
const videoPlaceholder = document.getElementById('videoPlaceholder');
const mediaViewport = document.getElementById('mediaViewport');
const fullscreenBtn = document.getElementById('fullscreenBtn');

const audioBarsContainer = document.getElementById('audioBarsContainer');
const audioLevelLabel = document.getElementById('audioLevelLabel');

const locationDetails = document.getElementById('locationDetails');
const locationStatusTag = document.getElementById('locationStatusTag');
const filesContainer = document.getElementById('filesContainer');
const fileCountBadge = document.getElementById('fileCountBadge');

const auditLogList = document.getElementById('auditLogList');
const chatHistory = document.getElementById('chatHistory');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');

// Initialize audio visualizer bars
const NUM_AUDIO_BARS = 16;
for (let i = 0; i < NUM_AUDIO_BARS; i++) {
  const bar = document.createElement('div');
  bar.className = 'audio-bar';
  audioBarsContainer.appendChild(bar);
}
const audioBars = audioBarsContainer.querySelectorAll('.audio-bar');

// Session Creation Form Submission
createSessionForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const operatorName = document.getElementById('operatorNameInput').value;
  const sessionPurpose = document.getElementById('sessionPurposeInput').value;
  const durationMinutes = document.getElementById('durationSelect').value;

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operatorName, sessionPurpose, durationMinutes })
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Server returned HTTP ${res.status}`);
    }

    if (!res.ok || !data.success) {
      alert(`Error creating session (${res.status}): ${data?.error || 'Server error'}`);
      return;
    }

    activeSession = data.session;
    startSessionSessionUI();
  } catch (err) {
    console.error('Session creation failed:', err);
    alert(`Failed to connect to server: ${err.message}`);
  }
});

// Start Session UI & WebSocket
function startSessionSessionUI() {
  createSessionSection.style.display = 'none';
  activeDashboard.style.display = 'block';
  sessionTimerBadge.style.display = 'inline-flex';
  headerEndBtn.style.display = 'inline-flex';

  sessionUrlDisplay.value = activeSession.recipientUrl;
  qrCodeImage.src = activeSession.qrCodeDataUrl;

  updateConnectionStatus('waiting', 'Waiting for Customer to Join');
  startTimer(activeSession.expiresAt);

  // Initialize WebRTC Manager
  webrtc = new WebRTCManager({
    role: 'operator',
    onRemoteStream: (stream, track) => {
      console.log('[WebRTC] Received remote stream track:', track.kind);
      if (track.kind === 'video') {
        remoteVideo.srcObject = stream;
        remoteVideo.style.display = 'block';
        videoPlaceholder.style.display = 'none';
      } else if (track.kind === 'audio') {
        initAudioVisualizer(stream);
      }
    },
    onSignal: (signal) => {
      sendWsMessage({ type: 'webrtc_signal', signal });
    },
    onConnectionStateChange: (state) => {
      console.log('[WebRTC] Connection state:', state);
      if (state === 'connected') {
        appendAuditLog('WebRTC Peer Connection Established', 'system');
      }
    }
  });

  connectWebSocket();
}

// WebSocket Connection
function connectWebSocket() {
  const urlParams = new URLSearchParams(window.location.search);
  const customSignaling = window.SIGNALING_URL || urlParams.get('signaling');
  const signalingBase = customSignaling || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
  const separator = signalingBase.includes('?') ? '&' : '?';
  const wsUrl = `${signalingBase}${separator}sessionId=${activeSession.id}&role=operator&token=${activeSession.operatorToken}`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[WS] Connected to signaling server');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (err) {
      console.error('[WS Parse Error]:', err);
    }
  };

  ws.onclose = (event) => {
    console.log('[WS] Disconnected:', event.code, event.reason);
    if (activeSession && activeSession.status !== 'TERMINATED') {
      updateConnectionStatus('danger', 'Connection Lost');
    }
  };
}

function sendWsMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Handle Server Signaling & Events
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'session_sync': {
      activeSession = { ...activeSession, ...msg.session };
      renderPermissions(msg.session.permissions);
      if (msg.session.auditLog) {
        msg.session.auditLog.forEach(log => appendAuditLog(formatAuditMessage(log), log.actor, log.timestamp));
      }
      break;
    }

    case 'peer_status': {
      if (msg.role === 'recipient') {
        if (msg.connected) {
          updateConnectionStatus('waiting', 'Customer Reviewing Consent');
          appendAuditLog('Customer opened link & reviewing terms', 'recipient');
        } else {
          updateConnectionStatus('waiting', 'Customer Disconnected');
          appendAuditLog('Customer connection severed', 'recipient');
        }
      }
      break;
    }

    case 'consent_updated': {
      if (msg.accepted) {
        updateConnectionStatus('connected', 'Customer Accepted - Active');
        appendAuditLog('Customer explicitly accepted consent terms', 'recipient');
      } else {
        updateConnectionStatus('ended', 'Customer Declined Consent');
        appendAuditLog('Customer explicitly declined consent terms', 'recipient');
        teardownSession('Customer declined consent');
      }
      break;
    }

    case 'permission_updated': {
      updatePermissionTag(msg.capability, msg.status);
      appendAuditLog(`Permission for ${msg.capability} is now ${msg.status}`, 'recipient');

      if (msg.status === 'revoked' || msg.status === 'denied') {
        if (msg.capability === 'camera' || msg.capability === 'screen') {
          remoteVideo.srcObject = null;
          remoteVideo.style.display = 'none';
          videoPlaceholder.style.display = 'flex';
        }
        if (msg.capability === 'microphone') {
          stopAudioVisualizer();
        }
      }
      break;
    }

    case 'webrtc_signal': {
      webrtc.handleSignal(msg.signal);
      break;
    }

    case 'location_updated': {
      renderLocation(msg.location);
      appendAuditLog('Customer shared geolocation coordinates', 'recipient');
      break;
    }

    case 'chat_message': {
      appendChatMessage(msg.sender, msg.text, msg.timestamp);
      break;
    }

    case 'session_terminated': {
      updateConnectionStatus('ended', 'Session Terminated');
      appendAuditLog(`Session closed: ${msg.reason}`, msg.terminatedBy || 'system');
      teardownSession(msg.reason);
      break;
    }

    default:
      console.log('[Operator WS Msg]:', msg);
  }
}

// Copy URL Button
copyUrlBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(sessionUrlDisplay.value);
    copyUrlBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyUrlBtn.textContent = '📋 Copy'; }, 2000);
  } catch {
    sessionUrlDisplay.select();
    document.execCommand('copy');
    copyUrlBtn.textContent = '✓ Copied!';
    setTimeout(() => { copyUrlBtn.textContent = '📋 Copy'; }, 2000);
  }
});

// Fullscreen Video Toggle
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    mediaViewport.requestFullscreen().catch(err => alert(`Fullscreen error: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
});

// Prompt Recipient for Permission Buttons
document.querySelectorAll('.req-perm-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const capability = btn.dataset.capability;
    sendWsMessage({ type: 'request_permission', capability });
    btn.textContent = 'Prompt Sent...';
    setTimeout(() => { btn.textContent = `Ask for ${capability}`; }, 2500);
    appendAuditLog(`Requested ${capability} permission from customer`, 'operator');
  });
});

// Chat Form Submission
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  sendWsMessage({ type: 'chat_message', text });
  chatInput.value = '';
});

function appendChatMessage(sender, text, timestamp) {
  const msgEl = document.createElement('div');
  const isMe = sender === 'operator';
  msgEl.style.padding = '0.35rem 0.6rem';
  msgEl.style.borderRadius = 'var(--radius-sm)';
  msgEl.style.background = isMe ? 'rgba(37, 99, 235, 0.2)' : 'rgba(51, 65, 85, 0.5)';
  msgEl.style.borderLeft = isMe ? '3px solid var(--primary)' : '3px solid var(--accent)';

  const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  msgEl.innerHTML = `
    <div style="display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-dim);">
      <strong>${isMe ? 'You (Operator)' : 'Customer'}</strong>
      <span>${timeStr}</span>
    </div>
    <div style="margin-top: 0.2rem; color: var(--text-main); word-break: break-word;">${escapeHtml(text)}</div>
  `;
  chatHistory.appendChild(msgEl);
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

// End Session Handlers
headerEndBtn.addEventListener('click', confirmEndSession);
mainEndBtn.addEventListener('click', confirmEndSession);

function confirmEndSession() {
  if (confirm('Are you sure you want to terminate this support session immediately? All customer permissions will be permanently revoked.')) {
    sendWsMessage({ type: 'terminate_session', reason: 'Operator terminated session' });
    teardownSession('Terminated by Operator');
  }
}

function teardownSession(reason) {
  updateConnectionStatus('ended', 'Session Terminated');
  clearInterval(timerInterval);

  if (webrtc) {
    webrtc.teardown();
  }
  stopAudioVisualizer();

  remoteVideo.srcObject = null;
  remoteVideo.style.display = 'none';
  videoPlaceholder.style.display = 'flex';
  videoPlaceholder.innerHTML = `
    <div class="media-placeholder-icon">🛑</div>
    <div><strong>Session Ended</strong></div>
    <div style="font-size: 0.85rem;">${reason || 'The session has been terminated.'}</div>
  `;

  headerEndBtn.disabled = true;
  mainEndBtn.disabled = true;
}

// Audio Visualizer Implementation
function initAudioVisualizer(stream) {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    const source = audioContext.createMediaStreamSource(stream);
    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 64;
    source.connect(audioAnalyser);

    const bufferLength = audioAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    audioLevelLabel.textContent = 'Active (Live)';
    audioLevelLabel.style.color = 'var(--success)';

    function renderAudio() {
      audioAnimationId = requestAnimationFrame(renderAudio);
      audioAnalyser.getByteFrequencyData(dataArray);

      for (let i = 0; i < NUM_AUDIO_BARS; i++) {
        const val = dataArray[i * 2] || 0;
        const heightPercent = Math.max(10, Math.min(100, (val / 255) * 100));
        audioBars[i].style.height = `${heightPercent}%`;
        audioBars[i].style.backgroundColor = val > 120 ? 'var(--success)' : 'var(--primary)';
      }
    }
    renderAudio();
  } catch (err) {
    console.warn('[Audio Visualizer Error]:', err);
  }
}

function stopAudioVisualizer() {
  if (audioAnimationId) {
    cancelAnimationFrame(audioAnimationId);
    audioAnimationId = null;
  }
  audioLevelLabel.textContent = 'Muted / Inactive';
  audioLevelLabel.style.color = 'var(--text-dim)';
  audioBars.forEach(b => { b.style.height = '10%'; b.style.backgroundColor = 'var(--primary)'; });
}

// Helpers
function updateConnectionStatus(type, text) {
  connectionStatusPill.className = `status-pill ${type}`;
  connectionStatusText.textContent = text;
}

function startTimer(expiresAt) {
  function tick() {
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      sessionTimerText.textContent = '00:00 (Expired)';
      teardownSession('Session time limit expired');
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    sessionTimerText.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function renderPermissions(perms) {
  if (!perms) return;
  for (const [capability, status] of Object.entries(perms)) {
    updatePermissionTag(capability, status);
  }
}

function updatePermissionTag(capability, status) {
  const el = document.getElementById(`permTag_${capability}`);
  if (!el) return;

  const statusMap = {
    not_requested: { text: 'Not Requested', cls: 'tag-not-requested' },
    pending: { text: 'Pending Consent', cls: 'tag-pending' },
    granted: { text: 'Granted', cls: 'tag-granted' },
    denied: { text: 'Denied by User', cls: 'tag-denied' },
    skipped: { text: 'Skipped', cls: 'tag-skipped' },
    revoked: { text: 'Revoked', cls: 'tag-revoked' }
  };

  const meta = statusMap[status] || { text: status, cls: 'tag-not-requested' };
  el.className = `perm-status-tag ${meta.cls}`;
  el.textContent = meta.text;
}

function renderLocation(loc) {
  if (!loc) return;
  locationStatusTag.className = 'perm-status-tag tag-granted';
  locationStatusTag.textContent = 'Verified';

  const mapUrl = `https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=16/${loc.latitude}/${loc.longitude}`;
  locationDetails.innerHTML = `
    <div><strong>Coordinates:</strong> ${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}</div>
    <div><strong>Accuracy:</strong> ~${Math.round(loc.accuracy)} meters</div>
    <div style="margin-top: 0.5rem;">
      <a href="${mapUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">
        🗺️ Open in OpenStreetMap
      </a>
    </div>
  `;
}

function formatAuditMessage(log) {
  const event = log.event;
  const d = log.details || {};
  switch (event) {
    case 'SESSION_CREATED': return `Session created by ${d.operatorName} (${d.durationMinutes}m)`;
    case 'RECIPIENT_CONNECTED': return 'Customer connected to session';
    case 'CONSENT_ACCEPTED': return 'Customer accepted consent';
    case 'CONSENT_DECLINED': return 'Customer declined consent';
    case 'LOCATION_SHARED': return `Location shared (accuracy ${d.accuracyMeters}m)`;
    case 'FILE_SHARED': return `Diagnostic file uploaded: ${d.originalName}`;
    case 'SESSION_TERMINATED': return `Session ended: ${d.reason}`;
    default: return `${event} ${JSON.stringify(d)}`;
  }
}

function appendAuditLog(text, actor = 'system', timestamp = new Date().toISOString()) {
  const item = document.createElement('div');
  item.className = 'audit-item';
  const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  item.innerHTML = `
    <span class="audit-time">${time}</span>
    <span style="color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase;">[${escapeHtml(actor)}]</span>
    <span style="flex: 1;">${escapeHtml(text)}</span>
  `;
  auditLogList.prepend(item);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
