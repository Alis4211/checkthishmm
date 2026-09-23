import { WebSocketServer, WebSocket } from 'ws';
import { sessionManager } from './sessionManager.js';

export function setupSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Map of sessionId -> { operatorWs: WebSocket, recipientWs: WebSocket }
  const sessionRooms = new Map();

  function getOrCreateRoom(sessionId) {
    if (!sessionRooms.has(sessionId)) {
      sessionRooms.set(sessionId, { operatorWs: null, recipientWs: null });
    }
    return sessionRooms.get(sessionId);
  }

  function broadcastToRoom(sessionId, message, excludeWs = null) {
    const room = sessionRooms.get(sessionId);
    if (!room) return;
    const payload = JSON.stringify(message);

    if (room.operatorWs && room.operatorWs !== excludeWs && room.operatorWs.readyState === WebSocket.OPEN) {
      room.operatorWs.send(payload);
    }
    if (room.recipientWs && room.recipientWs !== excludeWs && room.recipientWs.readyState === WebSocket.OPEN) {
      room.recipientWs.send(payload);
    }
  }

  wss.on('connection', (ws, req) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const sessionId = url.searchParams.get('sessionId');
      const role = url.searchParams.get('role'); // 'operator' or 'recipient'
      const token = url.searchParams.get('token');

      if (!sessionId || !role || !token) {
        ws.close(4400, 'Missing authentication parameters');
        return;
      }

      const session = sessionManager.getSession(sessionId);
      if (!session) {
        ws.close(4404, 'Session not found or expired');
        return;
      }

      if (session.status === 'TERMINATED') {
        ws.close(4410, 'Session has already terminated');
        return;
      }

      // Authenticate role
      let authenticated = false;
      if (role === 'operator') {
        authenticated = sessionManager.validateOperator(sessionId, token);
      } else if (role === 'recipient') {
        authenticated = sessionManager.validateRecipient(sessionId, token);
      }

      if (!authenticated) {
        ws.close(4401, 'Invalid authentication token');
        return;
      }

      ws.sessionId = sessionId;
      ws.role = role;
      ws.isAlive = true;

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      const room = getOrCreateRoom(sessionId);
      if (role === 'operator') {
        room.operatorWs = ws;
        session.operatorConnected = true;
        sessionManager.addAuditLog(sessionId, 'OPERATOR_CONNECTED', {}, 'operator');
      } else {
        room.recipientWs = ws;
        session.recipientConnected = true;
        sessionManager.addAuditLog(sessionId, 'RECIPIENT_CONNECTED', {}, 'recipient');

        if (session.status === 'CREATED') {
          session.status = 'CONSENT_REVIEW';
        }
      }

      // Send initial synchronization packet to connecting client
      ws.send(JSON.stringify({
        type: 'session_sync',
        session: {
          id: session.id,
          operatorName: session.operatorName,
          sessionPurpose: session.sessionPurpose,
          status: session.status,
          expiresAt: session.expiresAt,
          permissions: session.permissions,
          location: session.location,
          uploadedFiles: session.uploadedFiles,
          auditLog: role === 'operator' ? session.auditLog : undefined,
          role
        }
      }));

      // Notify the other peer
      broadcastToRoom(sessionId, {
        type: 'peer_status',
        role,
        connected: true,
        status: session.status
      }, ws);

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          handleClientMessage(ws, msg);
        } catch (err) {
          console.error('[WS Parse Error]:', err.message);
        }
      });

      ws.on('close', () => {
        const currentRoom = sessionRooms.get(sessionId);
        if (currentRoom) {
          if (role === 'operator' && currentRoom.operatorWs === ws) {
            currentRoom.operatorWs = null;
            session.operatorConnected = false;
          } else if (role === 'recipient' && currentRoom.recipientWs === ws) {
            currentRoom.recipientWs = null;
            session.recipientConnected = false;
          }
        }

        broadcastToRoom(sessionId, {
          type: 'peer_status',
          role,
          connected: false
        });
      });

    } catch (err) {
      console.error('[WS Connection Error]:', err);
      ws.close(4500, 'Server internal error');
    }
  });

  function handleClientMessage(ws, msg) {
    const { sessionId, role } = ws;
    const session = sessionManager.getSession(sessionId);
    if (!session || session.status === 'TERMINATED') {
      ws.send(JSON.stringify({ type: 'session_terminated', reason: 'Session is terminated' }));
      return;
    }

    const room = sessionRooms.get(sessionId);

    switch (msg.type) {
      case 'consent_decision': {
        if (role !== 'recipient') return;
        const accepted = Boolean(msg.accepted);
        sessionManager.recordConsent(sessionId, accepted);

        broadcastToRoom(sessionId, {
          type: 'consent_updated',
          accepted,
          status: session.status
        });

        if (!accepted) {
          closeRoomConnections(sessionId, 'Recipient declined consent');
        }
        break;
      }

      case 'permission_change': {
        const { capability, status } = msg;
        if (!capability || !status) return;

        // Recipient can grant, deny, skip, revoke
        // Operator can only request
        if (role === 'recipient') {
          sessionManager.updatePermission(sessionId, capability, status, 'recipient');
          broadcastToRoom(sessionId, {
            type: 'permission_updated',
            capability,
            status,
            permissions: session.permissions
          });
        }
        break;
      }

      case 'request_permission': {
        // Operator requests recipient to consider granting a permission
        if (role !== 'operator') return;
        const { capability } = msg;
        if (capability && room?.recipientWs?.readyState === WebSocket.OPEN) {
          sessionManager.addAuditLog(sessionId, 'PERMISSION_REQUEST_SENT', { capability }, 'operator');
          room.recipientWs.send(JSON.stringify({
            type: 'permission_requested_by_operator',
            capability
          }));
        }
        break;
      }

      case 'revoke_permission': {
        if (role !== 'recipient') return;
        const { capability } = msg;
        if (capability) {
          sessionManager.updatePermission(sessionId, capability, 'revoked', 'recipient');
          broadcastToRoom(sessionId, {
            type: 'permission_updated',
            capability,
            status: 'revoked',
            permissions: session.permissions
          });
        }
        break;
      }

      case 'location_update': {
        if (role !== 'recipient') return;
        sessionManager.storeLocation(sessionId, msg.location);
        broadcastToRoom(sessionId, {
          type: 'location_updated',
          location: session.location
        });
        break;
      }

      case 'webrtc_signal': {
        // Relay WebRTC signals (offer, answer, ice-candidate) to the opposite peer
        const targetWs = role === 'operator' ? room?.recipientWs : room?.operatorWs;
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: 'webrtc_signal',
            signal: msg.signal,
            from: role,
            mediaType: msg.mediaType // 'camera', 'microphone', 'screen'
          }));
        }
        break;
      }

      case 'chat_message': {
        const text = String(msg.text || '').trim().slice(0, 500);
        if (!text) return;

        const chatPayload = {
          type: 'chat_message',
          sender: role,
          text,
          timestamp: new Date().toISOString()
        };

        broadcastToRoom(sessionId, chatPayload);
        sessionManager.addAuditLog(sessionId, 'CHAT_MESSAGE', { sender: role }, role);
        break;
      }

      case 'terminate_session': {
        const reason = msg.reason || `${role === 'operator' ? 'Operator' : 'Recipient'} ended the session`;
        sessionManager.terminateSession(sessionId, reason, role);

        broadcastToRoom(sessionId, {
          type: 'session_terminated',
          reason,
          terminatedBy: role
        });

        closeRoomConnections(sessionId, reason);
        break;
      }

      default:
        console.warn(`[WS Unknown Type]: ${msg.type}`);
    }
  }

  function closeRoomConnections(sessionId, reason) {
    const room = sessionRooms.get(sessionId);
    if (!room) return;

    const payload = JSON.stringify({
      type: 'session_terminated',
      reason
    });

    if (room.operatorWs && room.operatorWs.readyState === WebSocket.OPEN) {
      room.operatorWs.send(payload);
      room.operatorWs.close(4000, reason);
    }
    if (room.recipientWs && room.recipientWs.readyState === WebSocket.OPEN) {
      room.recipientWs.send(payload);
      room.recipientWs.close(4000, reason);
    }

    sessionRooms.delete(sessionId);
  }

  // Heartbeat ping interval
  const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  return { wss, sessionRooms, broadcastToRoom, closeRoomConnections };
}
