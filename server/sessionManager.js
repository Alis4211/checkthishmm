import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from './config.js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'remote-assist-production-secret-v1-2026';
const STORAGE_FILE = path.join(os.tmpdir(), 'remote_assist_sessions_store.json');

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.loadFromStorage();

    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), config.sessionCleanupIntervalMs);
    if (this.cleanupInterval?.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Generates a signed cryptographic token carrying state across serverless containers.
   */
  signToken(payload) {
    const jsonStr = JSON.stringify(payload);
    const b64 = Buffer.from(jsonStr).toString('base64url');
    const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    return `${b64}.${hmac}`;
  }

  /**
   * Verifies and decodes a signed cryptographic token.
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [b64, hmac] = parts;
    try {
      const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
      if (crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) {
        return JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Generates a cryptographically secure random token.
   */
  generateSecureToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Loads sessions from shared temporary disk storage (for serverless environments).
   */
  loadFromStorage() {
    try {
      if (fs.existsSync(STORAGE_FILE)) {
        const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item && item.id && Date.now() < item.expiresAt) {
              this.sessions.set(item.id, item);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Storage] Load warning:', err.message);
    }
  }

  /**
   * Persists sessions to temporary disk storage.
   */
  saveToStorage() {
    try {
      const data = Array.from(this.sessions.values()).filter(s => Date.now() < s.expiresAt);
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(data), 'utf8');
    } catch (err) {
      console.warn('[Storage] Save warning:', err.message);
    }
  }

  /**
   * Creates a new support session.
   */
  createSession({ operatorName = 'Support Specialist', sessionPurpose = 'Technical Assistance', durationMinutes = 30 } = {}) {
    const sessionId = this.generateSecureToken(16); // 32 hex chars

    const durationMs = Math.min(
      Math.max(durationMinutes * 60 * 1000, 5 * 60 * 1000), // Min 5 min
      config.maxSessionDurationMs
    );

    const now = Date.now();
    const expiresAt = now + durationMs;

    const opName = String(operatorName).trim().slice(0, 80) || 'Support Specialist';
    const purpose = String(sessionPurpose).trim().slice(0, 200) || 'Technical Assistance';

    // Cryptographically signed tokens that survive serverless function restarts
    const operatorToken = this.signToken({
      id: sessionId,
      role: 'operator',
      exp: expiresAt,
      cr: now
    });

    const recipientToken = this.signToken({
      id: sessionId,
      role: 'recipient',
      op: opName,
      p: purpose,
      exp: expiresAt,
      cr: now
    });

    const session = {
      id: sessionId,
      operatorToken,
      recipientToken,
      operatorName: opName,
      sessionPurpose: purpose,
      status: 'CREATED',
      createdAt: now,
      expiresAt,
      terminatedAt: null,
      terminationReason: null,
      permissions: {
        camera: 'not_requested',     // not_requested | pending | granted | denied | skipped | revoked
        microphone: 'not_requested',
        screen: 'not_requested',
        geolocation: 'not_requested',
        files: 'not_requested'
      },
      recipientConnected: false,
      operatorConnected: false,
      location: null,
      uploadedFiles: [],
      auditLog: []
    };

    this.sessions.set(sessionId, session);
    this.saveToStorage();

    this.addAuditLog(sessionId, 'SESSION_CREATED', {
      operatorName: session.operatorName,
      purpose: session.sessionPurpose,
      durationMinutes: Math.round(durationMs / 60000)
    }, 'operator');

    return session;
  }

  /**
   * Retrieves a session by ID. If not found in memory, attempts storage load
   * or cryptographic reconstitution via signed token (essential for Vercel Serverless).
   */
  getSession(sessionId, token = null) {
    if (!sessionId) return null;

    let session = this.sessions.get(sessionId);

    // If not in local RAM, check disk storage
    if (!session) {
      this.loadFromStorage();
      session = this.sessions.get(sessionId);
    }

    // If still not found and token is present, reconstitute from verified token
    if (!session && token) {
      const payload = this.verifyToken(token);
      if (payload && payload.id === sessionId && Date.now() <= payload.exp) {
        session = {
          id: sessionId,
          operatorToken: this.signToken({ id: sessionId, role: 'operator', exp: payload.exp, cr: payload.cr || Date.now() }),
          recipientToken: token,
          operatorName: payload.op || 'Support Specialist',
          sessionPurpose: payload.p || 'Technical Assistance',
          status: 'ACTIVE',
          createdAt: payload.cr || Date.now(),
          expiresAt: payload.exp,
          terminatedAt: null,
          terminationReason: null,
          permissions: {
            camera: 'not_requested',
            microphone: 'not_requested',
            screen: 'not_requested',
            geolocation: 'not_requested',
            files: 'not_requested'
          },
          recipientConnected: true,
          operatorConnected: false,
          location: null,
          uploadedFiles: [],
          auditLog: []
        };
        this.sessions.set(sessionId, session);
        this.saveToStorage();
      }
    }

    if (!session) return null;

    if (this.isExpired(session) && session.status !== 'TERMINATED') {
      this.terminateSession(sessionId, 'Session expired due to time limit', 'system');
    }

    return session;
  }

  isExpired(session) {
    return Date.now() > session.expiresAt;
  }

  validateOperator(sessionId, token) {
    if (!sessionId || !token) return false;
    const session = this.getSession(sessionId, token);
    if (!session) return false;

    // Check exact token match or valid signed operator token
    if (session.operatorToken === token) return true;
    const payload = this.verifyToken(token);
    return Boolean(payload && payload.id === sessionId && payload.role === 'operator' && Date.now() <= payload.exp);
  }

  validateRecipient(sessionId, token) {
    if (!sessionId || !token) return false;
    const session = this.getSession(sessionId, token);
    if (!session) return false;

    // Check exact token match or valid signed recipient token
    if (session.recipientToken === token) return true;
    const payload = this.verifyToken(token);
    return Boolean(payload && payload.id === sessionId && payload.role === 'recipient' && Date.now() <= payload.exp);
  }

  getPublicSessionInfo(sessionId, token = null) {
    const session = this.getSession(sessionId, token);
    if (!session) return null;

    return {
      id: session.id,
      operatorName: session.operatorName,
      sessionPurpose: session.sessionPurpose,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      permissions: session.permissions,
      isExpired: this.isExpired(session)
    };
  }

  recordConsent(sessionId, accepted) {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'TERMINATED') return false;

    if (accepted) {
      session.status = 'ACTIVE';
      this.addAuditLog(sessionId, 'CONSENT_ACCEPTED', {
        message: 'Recipient connected and accepted direct support session'
      }, 'recipient');
    } else {
      this.addAuditLog(sessionId, 'CONSENT_DECLINED', {
        message: 'Recipient explicitly declined the session'
      }, 'recipient');
      this.terminateSession(sessionId, 'Recipient declined consent terms', 'recipient');
    }
    this.saveToStorage();
    return true;
  }

  updatePermission(sessionId, capability, status, actor = 'recipient') {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'TERMINATED') return false;

    const validCapabilities = ['camera', 'microphone', 'screen', 'geolocation', 'files'];
    const validStatuses = ['not_requested', 'pending', 'granted', 'denied', 'skipped', 'revoked'];

    if (!validCapabilities.includes(capability) || !validStatuses.includes(status)) {
      return false;
    }

    session.permissions[capability] = status;
    this.saveToStorage();

    this.addAuditLog(sessionId, `PERMISSION_${status.toUpperCase()}`, {
      capability,
      newStatus: status
    }, actor);

    return true;
  }

  storeLocation(sessionId, locationData) {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'ACTIVE') return false;

    session.location = {
      latitude: Number(locationData.latitude),
      longitude: Number(locationData.longitude),
      accuracy: Number(locationData.accuracy || 0),
      timestamp: Date.now()
    };
    this.saveToStorage();

    this.addAuditLog(sessionId, 'LOCATION_SHARED', {
      accuracyMeters: session.location.accuracy
    }, 'recipient');

    return true;
  }

  addUploadedFile(sessionId, fileData) {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'ACTIVE') return false;

    const fileRecord = {
      id: this.generateSecureToken(8),
      originalName: fileData.originalname,
      filename: fileData.filename,
      size: fileData.size,
      mimeType: fileData.mimetype,
      uploadedAt: Date.now()
    };

    session.uploadedFiles.push(fileRecord);
    this.saveToStorage();

    this.addAuditLog(sessionId, 'FILE_SHARED', {
      originalName: fileRecord.originalName,
      size: fileRecord.size
    }, 'recipient');

    return fileRecord;
  }

  terminateSession(sessionId, reason = 'Session ended', actor = 'system') {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status !== 'TERMINATED') {
      session.status = 'TERMINATED';
      session.terminatedAt = Date.now();
      session.terminationReason = reason;

      for (const cap of Object.keys(session.permissions)) {
        if (session.permissions[cap] === 'granted') {
          session.permissions[cap] = 'revoked';
        }
      }

      this.saveToStorage();
      this.addAuditLog(sessionId, 'SESSION_TERMINATED', { reason, terminatedBy: actor }, actor);
    }

    return true;
  }

  addAuditLog(sessionId, event, details = {}, actor = 'system') {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.auditLog.push({
      id: session.auditLog.length + 1,
      timestamp: new Date().toISOString(),
      event,
      details,
      actor
    });
    this.saveToStorage();
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (session.status === 'TERMINATED') {
        if (now - (session.terminatedAt || session.createdAt) > 30 * 60 * 1000) {
          this.sessions.delete(id);
        }
      } else if (now > session.expiresAt) {
        this.terminateSession(id, 'Session expired automatically', 'system');
      }
    }
    this.saveToStorage();
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export const sessionManager = new SessionManager();
