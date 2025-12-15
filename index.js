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
const PORT = 3000;

const mutex = new Mutex();
const msgRetryCounterCache = new NodeCache();

app.use(express.static(path.join(__dirname, 'static')));

let ACTIVE_SOCKET = null;

async function connector(NUMBER, res = null) {
  console.log('\n================ CONNECTOR START =================');

  const num = NUMBER.replace(/[^0-9]/g, '');
  const jid = num + '@s.whatsapp.net';

  console.log('[INFO] Raw number:', NUMBER);
  console.log('[INFO] Sanitized number:', num);
  console.log('[INFO] Target JID:', jid);

  const sessionDir = path.join(__dirname, 'session', num);
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    console.log('[FS] Created session dir:', sessionDir);
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

  // ===== VERY VERBOSE EVENTS =====

  sock.ev.on('creds.update', async () => {
    console.log('[EVENT] creds.update');
    await saveCreds();
    console.log('[AUTH] Credentials saved');
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
      console.log('[WAIT] Waiting for WhatsApp sync...');
      await delay(10000);

      try {
        // ============================
        // 1️⃣ SEND TEXT MESSAGE FIRST
        // ============================
        console.log('\n📤 SENDING TEXT MESSAGE...');
        const textMsg = await sock.sendMessage(jid, {
          text: config.MESSAGE
        });

        console.log('✅ TEXT SENT');
        console.log(JSON.stringify(textMsg, null, 2));

        await delay(3000);

        // ============================
        // 2️⃣ UPLOAD SESSION FILE
        // ============================
        console.log('\n📁 PREPARING SESSION FILE...');
        const credsPath = path.join(sessionDir, 'creds.json');

        if (!fs.existsSync(credsPath)) {
          console.log('❌ creds.json NOT FOUND');
          return;
        }

        console.log('📤 UPLOADING creds.json...');
        const url = await upload(credsPath);
        console.log('✅ UPLOAD URL:', url);

        let sessionID = 'UPLOAD_FAILED';
        if (url.includes('https://mega.nz/file/')) {
          sessionID = config.PREFIX + url.split('https://mega.nz/file/')[1];
        }

        console.log('🆔 SESSION ID:', sessionID);

        await delay(3000);

        // ============================
        // 3️⃣ SEND SESSION MESSAGE
        // ============================
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
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log('\n❌ CONNECTION CLOSED');
      console.log('REASON CODE:', reason);

      if (
        [
          DisconnectReason.connectionClosed,
          DisconnectReason.connectionLost,
          DisconnectReason.restartRequired
        ].includes(reason)
      ) {
        console.log('[RECONNECT] Attempting reconnect...');
        connector(num).catch(console.error);
      } else {
        console.log('[STOP] Not reconnecting');
      }
    }
  });

  // ===== PAIRING CODE =====
  if (!state.creds.registered) {
    console.log('\n🔑 REQUESTING PAIRING CODE...');
    await delay(2000);

    const code = await sock.requestPairingCode(num);
    const pretty = code.match(/.{1,4}/g).join('-');

    console.log('📱 PAIRING CODE:', pretty);

    if (res && !res.headersSent) {
      res.json({ code: pretty });
    }
  } else {
    console.log('[INFO] Device already registered');
    if (res && !res.headersSent) {
      res.json({ message: 'already_registered' });
    }
  }

  console.log('================ CONNECTOR END =================\n');
}

// ================= HTTP ROUTE =================

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

app.listen(PORT, () => {
  console.log(`\n🚀 SERVER RUNNING ON http://localhost:${PORT}\n`);
});
