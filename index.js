// server.js
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

// Map to track reconnect attempts per number to avoid tight loops
const reconnectAttempts = new Map();
const MAX_RECONNECTS = 3;
const RECONNECT_BACKOFF_MS = 3000;

app.use(express.static(path.join(__dirname, 'static')));

let ACTIVE_SOCKET = null;

/**
 * Create or get session directory for a number
 */
function getSessionDir(num) {
  return path.join(__dirname, 'session', num);
}

/**
 * Remove session dir safely
 */
function removeSessionDir(sessionDir) {
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[FS] Removed session dir:', sessionDir);
    }
  } catch (e) {
    console.warn('[FS] Failed to remove session dir:', sessionDir, e);
  }
}

/**
 * Main connector function
 * @param {string} NUMBER raw phone (with country code)
 * @param {express.Response|null} res optional http response for pairing endpoint
 */
async function connector(NUMBER, res = null) {
  console.log('\n================ CONNECTOR START =================');

  const num = NUMBER.replace(/[^0-9]/g, '');
  const jid = num + '@s.whatsapp.net';

  console.log('[INFO] Raw number:', NUMBER);
  console.log('[INFO] Sanitized number:', num);
  console.log('[INFO] Target JID:', jid);

  const sessionDir = getSessionDir(num);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    console.log('[FS] Created session dir:', sessionDir);
  }

  // limit reconnect loops
  const attempts = reconnectAttempts.get(num) || 0;
  if (attempts >= MAX_RECONNECTS) {
    console.log(`[STOP] Max reconnect attempts reached for ${num} (${attempts}). Remove session or wait before retrying.`);
    if (res && !res.headersSent) res.status(429).json({ error: 'too_many_reconnects' });
    return;
  }

  console.log('[AUTH] Loading auth state...');
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  console.log('[SOCKET] Creating WhatsApp socket...');
  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: 'fatal' })
      )
    },
    logger: pino({ level: 'fatal' }),
    browser: Browsers.macOS('Safari'),
    markOnlineOnConnect: true,
    msgRetryCounterCache
  });

  ACTIVE_SOCKET = sock;

  // Ensure we persist creds when Baileys tells us
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
      console.log('[AUTH] Credentials saved');
    } catch (err) {
      console.warn('[AUTH] Failed to save creds:', err);
    }
  });

  // Helpful debugging for incoming messages
  sock.ev.on('messages.upsert', (m) => {
    console.log('\n[EVENT] messages.upsert');
    console.log(JSON.stringify(m, null, 2));
  });

  // Handle connection lifecycle
  sock.ev.on('connection.update', async (update) => {
    console.log('\n[EVENT] connection.update');
    console.log(update);

    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      console.log('\n✅ CONNECTION OPEN');
      // reset reconnect attempts on successful open
      reconnectAttempts.set(num, 0);

      // wait a bit for WA to sync
      await delay(5000);

      // If device isn't registered, don't try to send session message
      if (!state.creds.registered || !state.creds.me?.id) {
        console.log('[AUTH] Device not fully registered yet. Finish pairing on phone first.');
        if (res && !res.headersSent) {
          res.json({ message: 'paired_but_not_registered' });
        }
        return;
      }

      try {
        // 1) send initial text
        console.log('\n📤 SENDING TEXT MESSAGE...');
        const textMsg = await sock.sendMessage(jid, { text: config.MESSAGE });
        console.log('✅ TEXT SENT');
        console.log(JSON.stringify(textMsg, null, 2));

        await delay(1500);

        // 2) upload creds.json
        const credsPath = path.join(sessionDir, 'creds.json');
        if (!fs.existsSync(credsPath)) {
          console.log('❌ creds.json NOT FOUND - skipping upload');
          return;
        }

        console.log('📤 UPLOADING creds.json...');
        const url = await upload(credsPath);
        console.log('✅ UPLOAD URL:', url);

        let sessionID = 'UPLOAD_FAILED';
        if (typeof url === 'string' && url.includes('https://mega.nz/file/')) {
          sessionID = config.PREFIX + url.split('https://mega.nz/file/')[1];
        }

        console.log('🆔 SESSION ID:', sessionID);

        await delay(1500);

        // 3) send session message
        console.log('\n📤 SENDING SESSION MESSAGE...');
        const sessionMsg = await sock.sendMessage(
          jid,
          {
            image: { url: config.IMAGE },
            caption: `*Session ID*\n\n${sessionID}`
          },
          { quoted: textMsg }
        );

        console.log('✅ SESSION MESSAGE SENT');
        console.log(JSON.stringify(sessionMsg, null, 2));
      } catch (err) {
        console.error('\n❌ ERROR WHILE SENDING:', err);
      }
    }

    if (connection === 'close') {
      const reasonCode = lastDisconnect?.error?.output?.statusCode;
      console.log('\n❌ CONNECTION CLOSED');
      console.log('REASON CODE:', reasonCode);

      // WhatsApp 401 Unauthorized — credentials invalid / must re-pair
      if (reasonCode === 401) {
        console.log('[AUTH] 401 Unauthorized: credentials invalid or expired.');
        // remove session to force fresh pairing on next attempt
        removeSessionDir(sessionDir);
        // increment reconnect attempts so we don't loop forever
        reconnectAttempts.set(num, (reconnectAttempts.get(num) || 0) + 1);

        console.log('[STOP] Not reconnecting automatically after 401. Start pair flow again.');
        if (res && !res.headersSent) res.status(401).json({ error: 'unauthorized', reason: 'invalid_credentials' });
        return;
      }

      // For recoverable disconnects, attempt reconnect with backoff, limited retries
      if (
        [
          DisconnectReason.connectionClosed,
          DisconnectReason.connectionLost,
          DisconnectReason.restartRequired
        ].includes(reasonCode)
      ) {
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

  // If not registered, expose pairing code immediately and return
  try {
    if (!state.creds.registered || !state.creds.me?.id) {
      console.log('\n🔑 REQUESTING PAIRING CODE...');
      // small delay to ensure socket ready to handle request
      await delay(500);

      // requestPairingCode may throw if not supported for some setups — wrap it
      try {
        const code = await sock.requestPairingCode(num);
        const pretty = String(code).match(/.{1,4}/g).join('-');
        console.log('📱 PAIRING CODE:', pretty);
        if (res && !res.headersSent) {
          res.json({ code: pretty });
        }
        // Return early: waiting for user to pair on phone (creds.update will fire then).
        console.log('[PAIR] Sent pairing code to caller. Finish pairing on the phone to register.');
        return;
      } catch (err) {
        console.warn('[PAIR] requestPairingCode failed:', err);
        // do not crash — continue and let connection.update handle open/close
      }
    } else {
      console.log('[INFO] Device already registered.');
      if (res && !res.headersSent) {
        res.json({ message: 'already_registered' });
      }
    }
  } catch (err) {
    console.error('[CONNECTOR] Unexpected error during pairing flow:', err);
    if (res && !res.headersSent) res.status(500).json({ error: 'pairing_failed' });
  }

  console.log('================ CONNECTOR END =================\n');
}

// ================= HTTP ROUTES =================

app.get('/pair', async (req, res) => {
  const number = req.query.code;
  if (!number) {
    return res.status(400).json({ error: 'Phone number required' });
  }

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
  res.json({
    active_socket: !!ACTIVE_SOCKET,
    reconnect_attempts: Object.fromEntries(reconnectAttempts)
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SERVER RUNNING ON http://localhost:${PORT}\n`);
});
