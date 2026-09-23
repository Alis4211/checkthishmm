import crypto from 'crypto';
import { config } from './config.js';

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.cleanupInterval = setInterval(() => this.cleanupExpiredSessions(), config.sessionCleanupIntervalMs);
  }

  /**
   * Generates a cryptographically secure random token.
   * @param {number} bytes 
   * @returns {string}
   */
  generateSecureToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
  }

  /**
   * Creates a new support session.
   */
  createSession({ operatorName = 'Support Specialist', sessionPurpose = 'Technical Assistance', durationMinutes = 30 } = {}) {
    const sessionId = this.generateSecureToken(16); // 32 hex chars
    const operatorToken = this.generateSecureToken(32);
    const recipientToken = this.generateSecureToken(32);

    const durationMs = Math.min(
      Math.max(durationMinutes * 60 * 1000, 5 * 60 * 1000), // Min 5 min
      config.maxSessionDurationMs
    );

    const now = Date.now();
    const expiresAt = now + durationMs;

    const session = {
      id: sessionId,
      operatorToken,
      recipientToken,
      operatorName: String(operatorName).trim().slice(0, 80) || 'Support Specialist',
      sessionPurpose: String(sessionPurpose).trim().slice(0, 200) || 'Technical Assistance',
      status: 'CREATED', // CREATED, CONSENT_REVIEW, ACTIVE, TERMINATED
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

    this.addAuditLog(sessionId, 'SESSION_CREATED', {
      operatorName: session.operatorName,
      purpose: session.sessionPurpose,
      durationMinutes: Math.round(durationMs / 60000)
    }, 'operator');

    return session;
  }

  /**
   * Retrieves a session by ID if it exists and is not expired.
   */
  getSession(sessionId) {
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (this.isExpired(session) && session.status !== 'TERMINATED') {
      this.terminateSession(sessionId, 'Session expired due to time limit', 'system');
    }

    return session;
  }

  /**
   * Checks if session has passed its expiration time.
   */
  isExpired(session) {
    return Date.now() > session.expiresAt;
  }

  /**
   * Validates operator token using timing-safe comparison.
   */
  validateOperator(sessionId, token) {
    const session = this.getSession(sessionId);
    if (!session || !token) return false;
    try {
      const bufA = Buffer.from(session.operatorToken, 'hex');
      const bufB = Buffer.from(token, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Validates recipient token using timing-safe comparison.
   */
  validateRecipient(sessionId, token) {
    const session = this.getSession(sessionId);
    if (!session || !token) return false;
    try {
      const bufA = Buffer.from(session.recipientToken, 'hex');
      const bufB = Buffer.from(token, 'hex');
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    } catch {
      return false;
    }
  }

  /**
   * Returns safe public metadata for recipient landing page.
   */
  getPublicSessionInfo(sessionId) {
    const session = this.getSession(sessionId);
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

  /**
   * Records recipient consent response.
   */
  recordConsent(sessionId, accepted) {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'TERMINATED') return false;

    if (accepted) {
      session.status = 'ACTIVE';
      this.addAuditLog(sessionId, 'CONSENT_ACCEPTED', {
        message: 'Recipient reviewed and accepted session consent terms'
      }, 'recipient');
    } else {
      this.addAuditLog(sessionId, 'CONSENT_DECLINED', {
        message: 'Recipient explicitly declined the session'
      }, 'recipient');
      this.terminateSession(sessionId, 'Recipient declined consent terms', 'recipient');
    }

    return true;
  }

  /**
   * Updates permission state for a specific capability.
   */
  updatePermission(sessionId, capability, status, actor = 'recipient') {
    const session = this.getSession(sessionId);
    if (!session || session.status === 'TERMINATED') return false;

    const validCapabilities = ['camera', 'microphone', 'screen', 'geolocation', 'files'];
    const validStatuses = ['not_requested', 'pending', 'granted', 'denied', 'skipped', 'revoked'];

    if (!validCapabilities.includes(capability) || !validStatuses.includes(status)) {
      return false;
    }

    const prevStatus = session.permissions[capability];
    session.permissions[capability] = status;

    this.addAuditLog(sessionId, `PERMISSION_${status.toUpperCase()}`, {
      capability,
      previousStatus: prevStatus,
      newStatus: status
    }, actor);

    return true;
  }

  /**
   * Stores recipient geolocation data with user consent.
   */
  storeLocation(sessionId, locationData) {
    const session = this.getSession(sessionId);
    if (!session || session.status !== 'ACTIVE') return false;

    session.location = {
      latitude: Number(locationData.latitude),
      longitude: Number(locationData.longitude),
      accuracy: Number(locationData.accuracy || 0),
      timestamp: Date.now()
    };

    this.addAuditLog(sessionId, 'LOCATION_SHARED', {
      accuracyMeters: session.location.accuracy
    }, 'recipient');

    return true;
  }

  /**
   * Registers a diagnostic file explicitly uploaded by the recipient.
   */
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

    this.addAuditLog(sessionId, 'FILE_SHARED', {
      originalName: fileRecord.originalName,
      size: fileRecord.size,
      mimeType: fileRecord.mimeType
    }, 'recipient');

    return fileRecord;
  }

  /**
   * Terminates a session immediately.
   */
  terminateSession(sessionId, reason = 'Session ended', actor = 'system') {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status !== 'TERMINATED') {
      session.status = 'TERMINATED';
      session.terminatedAt = Date.now();
      session.terminationReason = reason;

      // Revoke all granted permissions
      for (const cap of Object.keys(session.permissions)) {
        if (session.permissions[cap] === 'granted') {
          session.permissions[cap] = 'revoked';
        }
      }

      this.addAuditLog(sessionId, 'SESSION_TERMINATED', {
        reason,
        terminatedBy: actor
      }, actor);
    }

    return true;
  }

  /**
   * Appends an event to the session audit trail.
   */
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
  }

  /**
   * Background cleanup for old sessions.
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      // Retain terminated sessions for 30 minutes for audit retrieval, then purge
      if (session.status === 'TERMINATED') {
        if (now - (session.terminatedAt || session.createdAt) > 30 * 60 * 1000) {
          this.sessions.delete(id);
        }
      } else if (now > session.expiresAt) {
        this.terminateSession(id, 'Session expired automatically after timeout', 'system');
      }
    }
  }

  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export const sessionManager = new SessionManager();
