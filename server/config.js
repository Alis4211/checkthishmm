import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  useHttps: process.argv.includes('--https') || process.env.USE_HTTPS === 'true',
  publicDir: path.resolve(__dirname, '../public'),
  uploadsDir: process.env.VERCEL ? path.join(os.tmpdir(), 'uploads') : path.resolve(__dirname, '../uploads'),
  defaultSessionDurationMs: 30 * 60 * 1000, // 30 minutes
  maxSessionDurationMs: 120 * 60 * 1000,   // 2 hours max
  sessionCleanupIntervalMs: 30 * 1000,     // 30 seconds
  rateLimit: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxRequests: 100,         // General API
    maxSessionCreate: 30       // Max sessions created per IP
  }
};
