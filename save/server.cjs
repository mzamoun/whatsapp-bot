// --- server.cjs ---

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const pino = require('pino');
const path = require('path');

// --- Baileys imports (v6.7.0 oblige à utiliser default:) ---
const baileys = require("@whiskeysockets/baileys");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    jidNormalizedUser,
    DisconnectReason,
    makeInMemoryStore
} = baileys;

// --- CONFIGURATION SERVEUR ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static('public'));

function mz_log(s) {
    console.log(new Date() + " : ", s);
    return s;
}

// --- CONFIG ---
const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025";

let sock = null;
let store = null;

// --- FILTRE TEMPOREL ---
const targetDate = new Date("2025-12-10T00:00:00");
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

mz_log(`[BOOT] Filtre actif : Messages après ${targetDate.toLocaleString()}`);

// ============================================================
//  FONCTION TRAITEMENT DES MESSAGES
// ============================================================
async function processMessages(event, socket) {
    for (const msg of event.messages) {
        try {
            if (!msg.message) continue;

            // Fix timestamp (Long)
            let messageTime = msg.messageTimestamp;
            if (typeof messageTime !== 'number' && messageTime?.low)
                messageTime = msg.messageTimestamp.low;

            if (messageTime < targetTimestamp) continue;

            const chatId = msg.key.remoteJid;
            const text =
                msg.message.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                "";

            if (!text) continue;

            const normalizedText = text.toLowerCase();

            // =======================
            //  ANTI-SPAM
            // =======================
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
                    socket.emit("log", `${prefix} 🚨 Spam détecté → suppression et sanction`);

                    await sock.sendMessage(chatId, { delete: msg.key });

                    try {
                        await sock.updateBlockStatus(sender, "block");
                        await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                        socket.emit("log", `${prefix} 🔨 ${sender} bloqué + expulsé`);
                    } catch (err) {
                        socket.emit("log", `${prefix} ❌ Erreur action : ${err.message}`);
                    }
                } else {
                    socket.emit("log", `⚠️ Spam détecté mais le bot n'est PAS admin dans ${chatId}`);
                }
            }
        } catch (err) {
            console.error("Erreur processMessages :", err);
        }
    }
}

// ============================================================
//  SCAN HISTORIQUE (loadMessages)
// ============================================================
async function retroactiveScan(socket) {
    socket.emit("log", `⏳ Scan historique depuis ${targetDate.toLocaleString()}...`);

    if (!store || !sock) {
        socket.emit("log", "❌ Store ou socket non prêt");
        return;
    }

    const chats = store.chats.all();
    let total = 0;

    for (const chat of chats) {
        const jid = chat.id;
        if (!jid.endsWith("@g.us")) continue;

        try {
            const messages = await sock.loadMessages(jid, 50); // 🔥 API correcte
            if (messages?.length) {
                await processMessages({ messages, isRetroactive: true }, socket);
                total += messages.length;
            }
        } catch (err) {
            console.log("Erreur récupération:", err.message);
        }
    }

    socket.emit("log", `✅ Scan historique OK (${total} messages vérifiés)`);
}

// ============================================================
//  START BOT
// ============================================================
async function startBot(socket) {
    if (sock && sock.user) {
        socket.emit("status", { message: "Bot déjà connecté.", status: "open" });
        return;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), "auth"));

        sock = makeWASocket({
            logger: pino({ level: "silent" }),
            printQRInTerminal: false,
            syncFullHistory: true,
            auth: state
        });

        store = makeInMemoryStore({});
        store.bind(sock.ev);

        sock.ev.on("creds.update", saveCreds);

        let storeLoaded = false;

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) socket.emit("qr-code", qr);

            if (connection === "close") {
                const status = lastDisconnect?.error?.output?.statusCode;

                if (status !== DisconnectReason.loggedOut) {
                    socket.emit("status", { message: "Reconnexion...", status: "closed" });
                    setTimeout(() => startBot(socket), 5000);
                } else {
                    socket.emit("status", { message: "Session expirée.", status: "logged-out" });
                    sock = null;
                }
            }

            if (connection === "open") {
                socket.emit("status", {
                    message: "Synchronisation des chats...",
                    status: "syncing"
                });
            }
        });

        // Une fois que Baileys a chargé tous les chats :
        sock.ev.on("chats.set", () => {
            if (!storeLoaded) {
                storeLoaded = true;
                socket.emit("status", { message: "📌 Bot prêt", status: "open" });
                retroactiveScan(socket);
            }
        });

        // Messages en temps réel
        sock.ev.on("messages.upsert", async (event) => {
            await processMessages(event, socket);
        });

    } catch (err) {
        socket.emit("status", { message: "Erreur critique Baileys", status: "error" });
    }
}

// ============================================================
//  SOCKET.IO
// ============================================================
io.on("connection", (socket) => {

    // Lister les groupes
    socket.on("list-groups", () => {
        if (!sock || !store) {
            socket.emit("log", "❌ Bot non connecté");
            return;
        }
        const groups = store.chats.all()
            .filter(c => c.id.endsWith("@g.us"))
            .map(c => ({ name: c.name || c.id, jid: c.id }));

        socket.emit("groups-list", groups);
    });

    // Scan d’un groupe précis
    socket.on("scan-group", async ({ jid, startDate }) => {
        if (!sock) return socket.emit("log", "❌ Bot non connecté.");

        const timestamp = Math.floor(new Date(startDate).getTime() / 1000);
        let lastId = undefined;
        let totalChecked = 0;

        socket.emit("log", `⏳ Scan du groupe ${jid} depuis ${startDate}`);

        while (true) {
            try {
                const messages = await sock.loadMessages(jid, 50, lastId); // 🔥 correcte API

                if (!messages?.length) break;

                const filtered = messages.filter(m => {
                    let t = m.messageTimestamp;
                    if (typeof t !== 'number' && t?.low) t = t.low;
                    return t >= timestamp;
                });

                if (!filtered.length) break;

                totalChecked += filtered.length;

                await processMessages({ messages: filtered, isRetroactive: true }, socket);

                lastId = messages[messages.length - 1].key.id;

            } catch (err) {
                console.error("Erreur scan-group:", err);
                break;
            }
        }

        socket.emit("log", `✅ Scan terminé (${totalChecked} messages vérifiés).`);
    });

    socket.on("logout-bot", async () => {
        if (sock) try { await sock.logout(); } catch {}
        sock = null;
        store = null;
        socket.emit("status", { message: "Déconnecté.", status: "logged-out" });
    });

    socket.on("start-bot", () => startBot(socket));
});

// ============================================================
//  START SERVER
// ============================================================
httpServer.listen(PORT, () => {
    mz_log(`🌐 Serveur web sur http://localhost:${PORT}`);
});
