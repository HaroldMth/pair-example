// server_pairing_hold.js
// Drop-in replacement for your Baileys connector that holds pairing sockets a bit
// longer for ephemeral hosts (Render) and uses a temporary session folder while
// pairing. If pairing succeeds, session is moved to a persistent folder.

const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  Browsers,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require('baileys');

const { upload } = require('./mega');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

// Configurable env vars
const SESSION_BASE_DIR = process.env.SESSION_BASE_DIR || path.join(__dirname, 'session');
const PERSISTENT_BASE_DIR = process.env.PERSISTENT_BASE_DIR || path.join(__dirname, 'session_persist');
const PAIR_HOLD_MS = parseInt(process.env.PAIR_HOLD_MS || '45000', 10); // how long to hold socket after pairing code
const CLEANUP_DELAY_MS = parseInt(process.env.CLEANUP_DELAY_MS || '15000', 10); // grace period before deleting after 401
const MAX_RECONNECTS = parseInt(process.env.MAX_RECONNECTS || '3', 10);
const RECONNECT_BACKOFF_MS = parseInt(process.env.RECONNECT_BACKOFF_MS || '3000', 10);

app.use(express.static(path.join(__dirname, 'static')));

let ACTIVE_SOCKET = null;
const reconnectAttempts = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    console.log('[FS] Removed dir:', dir);
  } catch (e) {
    console.warn('[FS] Failed to remove dir:', dir, e?.message || e);
  }
}

function moveDir(src, dest) {
  try {
    ensureDir(path.dirname(dest));
    // use fs.rename first (fast), fallback to cp + rm if cross-device
    try {
      fs.renameSync(src, dest);
    } catch (err) {
      // fallback copy
      fs.cpSync(src, dest, { recursive: true });
      removeDir(src);
    }
    console.log('[FS] Moved session from', src, '->', dest);
  } catch (e) {
    console.warn('[FS] Failed to move session dir:', e.message || e);
  }
}

async function connector(NUMBER, res = null) {
  console.log('\n================ CONNECTOR START =================');

  const num = String(NUMBER).replace(/[^0-9]/g, '');
  const jid = num + '@s.whatsapp.net';

  console.log('[INFO] Raw number:', NUMBER);
  console.log('[INFO] Sanitized number:', num);
  console.log('[INFO] Target JID:', jid);

  // create a temporary session folder for pairing attempts to avoid race with ephemeral hosts
  ensureDir(SESSION_BASE_DIR);
  const tempDir = path.join(SESSION_BASE_DIR, `${num}-${Date.now()}`);
  ensureDir(tempDir);
  console.log('[FS] Using temporary session dir for pairing:', tempDir);

  // limit reconnect loops
  const attempts = reconnectAttempts.get(num) || 0;
  if (attempts >= MAX_RECONNECTS) {
    console.log(`[STOP] Max reconnect attempts reached for ${num} (${attempts}).`);
    if (res && !res.headersSent) res.status(429).json({ error: 'too_many_reconnects' });
    return;
  }

  console.log('[AUTH] Loading auth state...');
  const { state, saveCreds } = await useMultiFileAuthState(tempDir);

  // flag that will be set when registration completes
  let registered = Boolean(state.creds?.registered || state.creds?.me?.id);
  let cleanupTimer = null;

  console.log('[SOCKET] Creating WhatsApp socket...');
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
    },
    logger: pino({ level: 'fatal' }),
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: true,
    msgRetryCounterCache
  });

  ACTIVE_SOCKET = sock;

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      // re-read registration flag
      registered = Boolean(state.creds?.registered || state.creds?.me?.id);
      console.log('[AUTH] Credentials saved. registered=', registered);

      // If registered and we are using a persistent base, move the temp dir to persistent storage
      if (registered && PERSISTENT_BASE_DIR) {
        try {
          ensureDir(PERSISTENT_BASE_DIR);
          const dest = path.join(PERSISTENT_BASE_DIR, num);
          moveDir(tempDir, dest);
        } catch (err) {
          console.warn('[AUTH] Failed moving session to persistent dir:', err?.message || err);
        }
      }
    } catch (err) {
      console.warn('[AUTH] Failed to save creds:', err?.message || err);
    }
  });

  sock.ev.on('messages.upsert', (m) => {
    console.log('\n[EVENT] messages.upsert');
    console.log(JSON.stringify(m, null, 2));
  });

  sock.ev.on('connection.update', async (update) => {
    console.log('\n[EVENT] connection.update');
    console.log(update);

    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('\n✅ CONNECTION OPEN');
      reconnectAttempts.set(num, 0);
    }

    if (connection === 'close') {
      const reasonCode = lastDisconnect?.error?.output?.statusCode;
      console.log('\n❌ CONNECTION CLOSED');
      console.log('REASON CODE:', reasonCode);

      // 401 — unauthorized. Instead of immediate deletion, respect a short grace period
      if (reasonCode === 401) {
        console.log('[AUTH] 401 Unauthorized detected. Will wait a short grace period before cleaning temp session.');

        // if registration already happened, nothing to do
        if (registered) {
          console.log('[AUTH] Already registered. No cleanup necessary.');
          return;
        }

        // schedule cleanup after CLEANUP_DELAY_MS unless registered becomes true
        if (cleanupTimer) clearTimeout(cleanupTimer);
        cleanupTimer = setTimeout(() => {
          if (!registered) {
            console.log('[CLEANUP] 401 grace expired — removing temporary session dir:', tempDir);
            removeDir(tempDir);
          } else {
            console.log('[CLEANUP] Registered during grace window — keeping session.');
          }
        }, CLEANUP_DELAY_MS);

        return; // do not attempt immediate reconnect
      }

      // For recoverable disconnects, attempt reconnect with backoff, limited retries
      if ([DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.restartRequired].includes(reasonCode)) {
        const newAttempts = (reconnectAttempts.get(num) || 0) + 1;
        reconnectAttempts.set(num, newAttempts);

        if (newAttempts <= MAX_RECONNECTS) {
          console.log(`[RECONNECT] Attempt ${newAttempts}/${MAX_RECONNECTS} will retry in ${RECONNECT_BACKOFF_MS}ms...`);
          setTimeout(() => connector(num).catch(console.error), RECONNECT_BACKOFF_MS);
        } else {
          console.log('[STOP] Reached max reconnect attempts. Manual intervention required.');
        }
      } else {
        console.log('[STOP] Not reconnecting for this disconnect reason.');
      }
    }
  });

  // If not registered, request pairing code and hold socket open for PAIR_HOLD_MS
  try {
    if (!registered) {
      console.log('\n🔑 REQUESTING PAIRING CODE...');
      await delay(200); // small delay to let socket fully settle

      try {
        const rawCode = await sock.requestPairingCode(num);
        const pretty = String(rawCode).match(/.{1,4}/g).join('-');
        console.log('📱 PAIRING CODE:', pretty);
        console.log(`[PAIR] Holding socket for ${PAIR_HOLD_MS}ms to allow scanning.`);

        if (res && !res.headersSent) res.json({ code: pretty });

        // wait until either registered becomes true or timeout
        const start = Date.now();
        while (Date.now() - start < PAIR_HOLD_MS && !registered) {
          await delay(500);
        }

        if (registered) {
          console.log('[PAIR] Device registered successfully during hold window.');
          // If we moved the temp session in creds.update, nothing else to do
          // Optionally upload creds now
          try {
            const credsPath = path.join(PERSISTENT_BASE_DIR || tempDir, num, 'creds.json');
            // fallback to temp location if persistent not used
            const finalCredsPath = fs.existsSync(credsPath) ? credsPath : path.join(tempDir, 'creds.json');

            if (fs.existsSync(finalCredsPath)) {
              console.log('📤 UPLOADING creds.json...');
              const url = await upload(finalCredsPath);
              console.log('✅ UPLOAD URL:', url);
            }
          } catch (err) {
            console.warn('[UPLOAD] Failed to upload creds:', err?.message || err);
          }

        } else {
          console.log('[PAIR] Hold window expired and device not registered. Scheduling cleanup.');
          // schedule removal now (short delay) to give any last-second attempts a chance
          setTimeout(() => {
            if (!registered) removeDir(tempDir);
          }, 1000);
        }

        return; // stop here as pairing flow handled
      } catch (err) {
        console.warn('[PAIR] requestPairingCode failed:', err?.message || err);
        if (res && !res.headersSent) res.status(500).json({ error: 'pairing_failed', message: String(err?.message || err) });
      }
    } else {
      console.log('[INFO] Device already registered.');
      if (res && !res.headersSent) res.json({ message: 'already_registered' });
    }
  } catch (err) {
    console.error('[CONNECTOR] Unexpected error during pairing flow:', err?.message || err);
    if (res && !res.headersSent) res.status(500).json({ error: 'pairing_failed' });
  }

  console.log('================ CONNECTOR END =================\n');
}

// ================= HTTP ROUTES =================

app.get('/pair', async (req, res) => {
  const number = req.query.code;
  if (!number) return res.status(400).json({ error: 'Phone number required' });

  const release = await mutex.acquire();
  try {
    await connector(number, res);
  } catch (err) {
    console.error('PAIR ERROR:', err);
    if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
  } finally {
    release();
  }
});

app.get('/status', (req, res) => {
  res.json({ active_socket: !!ACTIVE_SOCKET, reconnect_attempts: Object.fromEntries(reconnectAttempts) });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SERVER RUNNING ON http://localhost:${PORT}\n`);
});
