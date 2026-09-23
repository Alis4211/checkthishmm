import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';

export function createApp() {
  const app = express();

  // Security Headers via Helmet with Content Security Policy
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"]
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );

  // Rate Limiting for session creation to prevent abuse
  const createSessionLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxSessionCreate,
    message: { success: false, error: 'Too many sessions created from this IP. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false
  });

  const generalApiLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    message: { success: false, error: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false
  });

  // Body Parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Apply rate limiter to session creation specifically
  app.use('/api/sessions', (req, res, next) => {
    if (req.method === 'POST') {
      return createSessionLimiter(req, res, next);
    }
    next();
  });

  // Apply general limiter to rest of API
  app.use('/api', generalApiLimiter);

  // Mount API router
  app.use('/api', apiRouter);

  // Serve static assets from public directory
  app.use(express.static(config.publicDir));

  // Client routing fallback for friendly URLs
  app.get('/join/:id', (req, res) => {
    res.sendFile(path.join(config.publicDir, 'session.html'));
  });

  app.get('/operator', (req, res) => {
    res.sendFile(path.join(config.publicDir, 'operator.html'));
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('[Unhandled Express Error]:', err);
    res.status(err.status || 500).json({
      success: false,
      error: err.message || 'An unexpected internal error occurred'
    });
  });

  return app;
}
