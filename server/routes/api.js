import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { sessionManager } from '../sessionManager.js';
import { config } from '../config.js';

export const apiRouter = express.Router();

// Ensure upload directory exists
try {
  if (!fs.existsSync(config.uploadsDir)) {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
  }
} catch (err) {
  console.warn('[Storage] Temporary upload dir initialization notice:', err.message);
}

// Multer storage for diagnostic uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadsDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    const safeName = `${Date.now()}-${sessionManager.generateSecureToken(8)}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 15 * 1024 * 1024 // 15MB limit
  },
  fileFilter: (req, file, cb) => {
    // Only allow diagnostic artifacts: images, text, pdf, logs, json
    const allowedMimes = [
      'image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'text/plain', 'text/csv', 'application/json', 'application/pdf',
      'application/octet-stream'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Disallowed file type. Diagnostic uploads only allow images, text, and documents.'));
    }
  }
});

/**
 * Helper to extract Bearer token from headers.
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  }
  return null;
}

/**
 * POST /api/sessions
 * Create a new support session (Operator initiated)
 */
apiRouter.post('/sessions', async (req, res) => {
  try {
    const { operatorName, sessionPurpose, durationMinutes } = req.body || {};

    const session = sessionManager.createSession({
      operatorName,
      sessionPurpose,
      durationMinutes: parseInt(durationMinutes, 10) || 30
    });

    const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.get('host') || `localhost:${config.port}`;
    const baseUrl = `${protocol}://${host}`;
    const recipientUrl = `${baseUrl}/session.html?id=${session.id}&token=${session.recipientToken}`;

    // Generate QR Code as data URL
    const qrCodeDataUrl = await QRCode.toDataURL(recipientUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      scale: 6,
      color: {
        dark: '#1e293b',
        light: '#ffffff'
      }
    });

    res.status(201).json({
      success: true,
      session: {
        id: session.id,
        operatorName: session.operatorName,
        sessionPurpose: session.sessionPurpose,
        operatorToken: session.operatorToken,
        recipientToken: session.recipientToken,
        recipientUrl,
        qrCodeDataUrl,
        expiresAt: session.expiresAt,
        status: session.status
      }
    });
  } catch (err) {
    console.error('[API Create Session Error]:', err);
    res.status(500).json({ success: false, error: 'Failed to create support session' });
  }
});

/**
 * GET /api/sessions/:id
 * Retrieve safe public session metadata for recipient consent view
 */
apiRouter.get('/sessions/:id', (req, res) => {
  const { id } = req.params;
  const sessionInfo = sessionManager.getPublicSessionInfo(id);

  if (!sessionInfo) {
    return res.status(404).json({ success: false, error: 'Session not found or expired' });
  }

  res.json({
    success: true,
    session: sessionInfo
  });
});

/**
 * GET /api/sessions/:id/operator
 * Retrieve full operator session state
 */
apiRouter.get('/sessions/:id/operator', (req, res) => {
  const { id } = req.params;
  const token = extractToken(req);

  if (!sessionManager.validateOperator(id, token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid operator credentials' });
  }

  const session = sessionManager.getSession(id);
  res.json({
    success: true,
    session: {
      id: session.id,
      operatorName: session.operatorName,
      sessionPurpose: session.sessionPurpose,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      permissions: session.permissions,
      recipientConnected: session.recipientConnected,
      location: session.location,
      uploadedFiles: session.uploadedFiles,
      auditLog: session.auditLog
    }
  });
});

/**
 * POST /api/sessions/:id/terminate
 * Terminate session by operator or recipient
 */
apiRouter.post('/sessions/:id/terminate', (req, res) => {
  const { id } = req.params;
  const token = extractToken(req);
  const { reason } = req.body || {};

  let actor = null;
  if (sessionManager.validateOperator(id, token)) {
    actor = 'operator';
  } else if (sessionManager.validateRecipient(id, token)) {
    actor = 'recipient';
  }

  if (!actor) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid token' });
  }

  const success = sessionManager.terminateSession(id, reason || `${actor} requested termination`, actor);
  res.json({ success, message: 'Session terminated' });
});

/**
 * POST /api/sessions/:id/upload
 * Recipient explicitly uploads a diagnostic photo or log file
 */
apiRouter.post('/sessions/:id/upload', (req, res) => {
  const { id } = req.params;
  const token = extractToken(req);

  if (!sessionManager.validateRecipient(id, token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Only the active recipient can upload files' });
  }

  const session = sessionManager.getSession(id);
  if (!session || session.status !== 'ACTIVE') {
    return res.status(400).json({ success: false, error: 'Session is not active' });
  }

  upload.single('diagnosticFile')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file provided' });
    }

    const fileRecord = sessionManager.addUploadedFile(id, req.file);
    res.status(201).json({
      success: true,
      file: fileRecord
    });
  });
});

/**
 * GET /api/sessions/:id/files/:filename
 * Safely view/download uploaded diagnostic file
 */
apiRouter.get('/sessions/:id/files/:filename', (req, res) => {
  const { id, filename } = req.params;
  const token = req.query.token || extractToken(req);

  const isOperator = sessionManager.validateOperator(id, token);
  const isRecipient = sessionManager.validateRecipient(id, token);

  if (!isOperator && !isRecipient) {
    return res.status(401).json({ success: false, error: 'Unauthorized file access' });
  }

  const safeFilename = path.basename(filename);
  const filePath = path.join(config.uploadsDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File not found' });
  }

  res.sendFile(filePath);
});
