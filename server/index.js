import http from 'http';
import https from 'https';
import os from 'os';
import selfsigned from 'selfsigned';
import { createApp } from './app.js';
import { setupSignaling } from './signaling.js';
import { config } from './config.js';

function getNetworkAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

async function startServer() {
  const app = createApp();
  let server;
  let protocol = 'http';

  if (config.useHttps) {
    protocol = 'https';
    console.log('[Security] Generating ephemeral self-signed SSL certificates for HTTPS...');
    const attrs = [{ name: 'commonName', value: 'localhost' }];
    const pems = selfsigned.generate(attrs, { days: 30, keySize: 2048 });
    server = https.createServer({
      key: pems.private,
      cert: pems.cert
    }, app);
    console.log('[Security] HTTPS server initialized.');
  } else {
    server = http.createServer(app);
  }

  // Bind WebSocket signaling to the server
  const signaling = setupSignaling(server);

  server.listen(config.port, config.host, () => {
    const lanIps = getNetworkAddresses();
    console.log('\n=============================================================');
    console.log('  CONSENT-BASED REMOTE SUPPORT APPLICATION');
    console.log('=============================================================');
    console.log(`  Mode:        ${protocol.toUpperCase()}`);
    console.log(`  Local:       ${protocol}://localhost:${config.port}`);
    lanIps.forEach(ip => {
      console.log(`  Network/LAN: ${protocol}://${ip}:${config.port} (Use this for Mobile Testing)`);
    });
    console.log(`  Operator UI: ${protocol}://localhost:${config.port}/operator.html`);
    console.log('=============================================================');
    console.log('  NOTE: Mobile browsers require HTTPS or localhost for');
    console.log('  camera/microphone permissions. Run "npm run start:https"');
    console.log('  to enable HTTPS on your local network.');
    console.log('=============================================================\n');
  });

  // Graceful shutdown handling
  const handleShutdown = () => {
    console.log('\n[System] Shutting down server gracefully...');
    server.close(() => {
      console.log('[System] Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  return { server, app, signaling };
}

startServer().catch(err => {
  console.error('[Fatal Startup Error]:', err);
  process.exit(1);
});
