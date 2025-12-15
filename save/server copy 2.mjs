// --- server.mjs ---

import baileys from '@whiskeysockets/baileys';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import pino from 'pino';
import { Server as SocketIOServer } from 'socket.io';

const {
    default: makeWASocket,
    useMultiFileAuthState,
    jidNormalizedUser,
    DisconnectReason,
    makeInMemoryStore
} = baileys;

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });
const PORT = 3000;

app.use(express.static('public'));

// ========================
// LOGS DÉTAILLÉS
// ========================
function mz_log(...args) {
    const d = new Date().toISOString();
    console.log(d, ...args);
    return args.join(' ');
}

// ========================
// CONFIG BOT
// ========================
const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025";
let sock = null;
let store = null;
const targetDate = new Date("2025-12-10T00:00:00");
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

mz_log(`[BOOT] Filtre messages après ${targetDate.toLocaleString()}`);

// ============================================================
// PROCESS MESSAGES
// ============================================================
async function processMessages(event, socket) {
    for (const msg of event.messages) {
        try {
            if (!msg.message) continue;
            let messageTime = msg.messageTimestamp;
            if (typeof messageTime !== 'number' && messageTime?.low)
                messageTime = msg.messageTimestamp.low;

            if (messageTime < targetTimestamp) continue;

            const chatId = msg.key.remoteJid;
            const text = msg.message.conversation
                || msg.message?.extendedTextMessage?.text
                || msg.message?.imageMessage?.caption
                || "";
            if (!text) continue;
            const normalizedText = text.toLowerCase();

            mz_log(`[MSG] Chat: ${chatId}, From: ${msg.key.participant || msg.key.remoteJid}, Text: ${text}`);

            if (normalizedText.includes(SPAM_LINK.toLowerCase())) {
                const sender = msg.key.participant || msg.key.remoteJid;
                let isAdmin = false;
                if (chatId.endsWith("@g.us")) {
                    const meta = await sock.groupMetadata(chatId);
                    const botId = jidNormalizedUser(sock.user.id);
                    const me = meta.participants.find(p => p.id === botId);
                    isAdmin = me && (me.admin === "admin" || me.admin === "superadmin");
                }

                const prefix = event.isRetroactive ? "[HISTORIQUE]" : "[LIVE]";

                if (isAdmin) {
                    socket.emit("log", `${prefix} 🚨 SPAM détecté → suppression et action`);
                    mz_log(`${prefix} SPAM détecté par bot admin → ${sender}`);
                    await sock.sendMessage(chatId, { delete: msg.key });
                    try {
                        await sock.updateBlockStatus(sender, "block");
                        await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                        socket.emit("log", `${prefix} 🔨 ${sender} bloqué + expulsé`);
                    } catch (err) {
                        socket.emit("log", `${prefix} ❌ Erreur action : ${err.message}`);
                    }
                } else {
                    socket.emit("log", `⚠️ Spam détecté mais bot n'est PAS admin dans ${chatId}`);
                }
            }
        } catch (err) {
            mz_log("❌ Erreur processMessages :", err);
        }
    }
}

// ============================================================
// SCAN HISTORIQUE
// ============================================================
async function retroactiveScan(socket) {
    socket.emit("log", `⏳ Scan historique depuis ${targetDate.toLocaleString()}...`);
    if (!store || !sock) return socket.emit("log", "❌ Store ou bot non prêt");

    const chats = store.chats.all();
    let total = 0;
    mz_log("[SCAN] Chats connus :", chats.map(c => c.id));

    for (const chat of chats) {
        if (!chat.id.endsWith("@g.us")) continue;
        try {
            const messages = await sock.loadMessages(chat.id, 50);
            if (messages?.length) {
                await processMessages({ messages, isRetroactive: true }, socket);
                total += messages.length;
            }
        } catch (err) {
            mz_log(`❌ Erreur récupération messages ${chat.id}:`, err.message);
        }
    }
    socket.emit("log", `✅ Scan historique terminé (${total} messages vérifiés)`);
}

// ============================================================
// START BOT
// ============================================================
async function startBot(socket) {
    if (sock && sock.user) {
        return socket.emit("status", { message: "Bot déjà connecté", status: "open" });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), "auth"));
        mz_log("[BOT] Création socket Baileys");

        sock = makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: true,
            syncFullHistory: true,
            auth: state
        });

        store = makeInMemoryStore({});
        store.bind(sock.ev);
        sock.ev.on("creds.update", saveCreds);

        let storeLoaded = false;

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                socket.emit("qr-code", qr);
                socket.emit("status", { message: "QR à scanner", status: "qr-pending" });
                mz_log("[QR] Scannez le QR code affiché dans le terminal ou interface");
            }

            if (connection === "close") {
                mz_log("[CONN] Connection close", lastDisconnect?.error?.output?.statusCode);
                if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
                    socket.emit("status", { message: "Reconnexion en cours...", status: "closed" });
                    setTimeout(() => startBot(socket), 5000);
                } else {
                    socket.emit("status", { message: "Session expirée", status: "logged-out" });
                    sock = null;
                }
            }

            if (connection === "open") {
                socket.emit("status", { message: "Connexion établie. Sync chats...", status: "syncing" });
                mz_log("[CONN] Bot connecté, attente sync chats...");
            }
        });

        sock.ev.on("chats.set", () => {
            if (!storeLoaded) {
                storeLoaded = true;
                socket.emit("status", { message: "Bot prêt ✔", status: "open" });
                mz_log("[CHATS.SET] Store rempli, lancement scan historique");
                retroactiveScan(socket);
            }
        });

        sock.ev.on("messages.upsert", async (event) => {
            mz_log("[MSG.UPSERT] Nouveau message reçu");
            await processMessages(event, socket);
        });

    } catch (err) {
        mz_log("❌ Erreur critique startBot :", err);
        socket.emit("status", { message: "Erreur critique Baileys", status: "error" });
    }
}

// ============================================================
// SOCKET.IO
// ============================================================
io.on("connection", (socket) => {

    mz_log(`[SOCKET.IO] Client connecté : ${socket.id}`);
    socket.emit("log", "Client connecté");

    socket.on("start-bot", () => startBot(socket));

    socket.on("list-groups", () => {
        if (!sock || !store) return socket.emit("log", "❌ Bot non connecté");
        const groups = store.chats.all()
            .filter(c => c.id.endsWith("@g.us"))
            .map(c => ({ name: c.name || c.id, jid: c.id }));
        socket.emit("groups-list", groups);
    });

    socket.on("scan-group", async ({ jid, startDate }) => {
        if (!sock) return socket.emit("log", "❌ Bot non connecté");

        const timestamp = Math.floor(new Date(startDate).getTime() / 1000);
        let lastId;
        let totalChecked = 0;
        socket.emit("log", `⏳ Scan du groupe ${jid} depuis ${startDate}`);

        while (true) {
            try {
                const messages = await sock.loadMessages(jid, 50, lastId);
                if (!messages?.length) break;

                const filtered = messages.filter(m => {
                    let t = m.messageTimestamp;
                    if (typeof t !== "number" && t?.low) t = t.low;
                    return t >= timestamp;
                });

                if (!filtered.length) break;

                totalChecked += filtered.length;
                await processMessages({ messages: filtered, isRetroactive: true }, socket);
                lastId = messages[messages.length - 1].key.id;

            } catch (err) {
                mz_log("❌ Erreur scan-group :", err);
                break;
            }
        }

        socket.emit("log", `✅ Scan terminé (${totalChecked} messages vérifiés)`);
    });

    socket.on("logout-bot", async () => {
        if (sock) try { await sock.logout(); } catch {}
        sock = null; store = null;
        socket.emit("status", { message: "Déconnecté.", status: "logged-out" });
        mz_log("[LOGOUT] Bot déconnecté");
    });

    socket.on("disconnect", () => {
        mz_log(`[SOCKET.IO] Client ${socket.id} déconnecté`);
    });
});

// ============================================================
// START SERVER
// ============================================================
server.listen(PORT, () => mz_log(`🌐 Serveur web sur http://localhost:${PORT}`));
