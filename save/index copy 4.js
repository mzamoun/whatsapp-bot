// index.js — debug friendly (ESM)
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys";
import express from "express";
import fs from "fs";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";

const LOG = pino({ level: "info" });

const AUTH_DIR = "./auth";
const PORT = process.env.PORT || 3000;

// ensure auth dir exists
try {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    LOG.info("Created auth dir:", AUTH_DIR);
  } else {
    LOG.info("Auth dir exists:", AUTH_DIR);
  }
} catch (e) {
  console.error("Failed to ensure auth dir:", e);
  process.exit(1);
}

// global error handlers
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err && err.stack ? err.stack : err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});

// start express early so we at least see something
const app = express();
app.get("/", (req, res) => res.send("WhatsApp bot running (debug)"));
app.listen(PORT, () => LOG.info(`Express server listening on http://localhost:${PORT}`));

// Main async starter with robust logging
async function startBot() {
  LOG.info("Starting WhatsApp bot...");

  try {
    const { version } = await fetchLatestBaileysVersion().catch(e => {
      LOG.warn("fetchLatestBaileysVersion failed, continuing with default. err:", e && e.message);
      return { version: [4, 0, 0] };
    });
    LOG.info("Baileys protocol version:", version);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    LOG.info("Loaded auth state from", AUTH_DIR);

    const sock = makeWASocket({
      logger: pino({ level: "silent" }),
      auth: state,
      // don't pass printQRInTerminal (deprecated)
    });

    // creds update
    sock.ev.on("creds.update", () => {
      LOG.info("Event: creds.update");
      try { saveCreds(); } catch (e) { LOG.warn("saveCreds failed:", e && e.message); }
    });

    // connection updates (QR, open, close)
    sock.ev.on("connection.update", (update) => {
      LOG.info("Event: connection.update", update && typeof update === "object" ? Object.keys(update) : update);

      const { qr, connection, lastDisconnect } = update;

      if (qr) {
        LOG.info("QR code received — printing to terminal (also show text)");
        qrcodeTerminal.generate(qr, { small: true });
        console.log("Raw QR (if you need it):", qr);
      }

      if (connection === "open") {
        LOG.info("WhatsApp connection open — bot connected!");
      }

      if (connection === "close") {
        LOG.warn("Connection closed:", lastDisconnect && lastDisconnect.error ? lastDisconnect.error : lastDisconnect);
        // try to restart after short delay
        setTimeout(() => {
          LOG.info("Restarting bot after connection close...");
          startBot().catch(e => LOG.error("startBot restart error:", e));
        }, 2000);
      }
    });

    // messages.upsert log minimal
    sock.ev.on("messages.upsert", (m) => {
      try {
        LOG.info("messages.upsert event. type:", m && m.type ? m.type : "unknown");
        if (Array.isArray(m.messages) && m.messages.length) {
          const msg = m.messages[0];
          const has = !!msg.message;
          LOG.info(" -> message present:", has, "from:", msg?.key?.remoteJid, "id:", msg?.key?.id);
        }
      } catch (e) {
        LOG.warn("Error in messages.upsert handler:", e && e.message);
      }
    });

    LOG.info("startBot finished setup. Waiting events...");
    return sock;

  } catch (err) {
    console.error("startBot fatal error:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

// Run
startBot()
  .then(() => LOG.info("Bot startup invoked"))
  .catch((e) => {
    console.error("startBot promise rejected:", e && e.stack ? e.stack : e);
  });
