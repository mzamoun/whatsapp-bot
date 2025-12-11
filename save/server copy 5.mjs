// =======================
//  IMPORTS
// =======================
import baileys from '@whiskeysockets/baileys';
import express from 'express';
import http from 'http';
import path from 'path';
import pino from 'pino';
import { Server as SocketIOServer } from 'socket.io';
import { fileURLToPath } from 'url';

const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    useMultiFileAuthState,
    jidNormalizedUser,
    DisconnectReason,
    makeInMemoryStore
} = baileys;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =======================
//  EXPRESS + SOCKET.IO
// =======================
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });
const PORT = 3000;

app.use(express.static('public'));

function mz_log(s, obj) {
    if (obj) console.log(new Date().toISOString(), s, obj);
    else console.log(new Date().toISOString(), s);
    return s;
}

// =======================
//  VARIABLES GLOBALES
// =======================
const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025";
let sock = null;
let store = null;
let retryCount = 0;
const MAX_RETRIES = 5;

// =======================
//  FILTRE TEMPOREL
// =======================
const targetDate = new Date("2025-12-10T00:00:00");
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
mz_log(`[BOOT] Filtre messages après ${targetDate.toLocaleString()}`);
mz_log(`🌐 Serveur web sur http://localhost:${PORT}`);

// =======================
//  TRAITEMENT DES MESSAGES
// =======================
async function processMessages(event, socket) {
    mz_log("processMessages DEB");
    for (const msg of event.messages) {
        try {
            if (!msg.message) continue;

            let messageTime = msg.messageTimestamp;
            if (typeof messageTime !== 'number' && messageTime?.low) messageTime = messageTime.low;
            if (messageTime < targetTimestamp) continue;

            const chatId = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
            const normalizedText = text.toLowerCase();
            if (!normalizedText) continue;

            if (normalizedText.includes(SPAM_LINK.toLowerCase())) {
                const sender = msg.key.participant || msg.key.remoteJid;
                let isAdmin = false;

                if (chatId && chatId.endsWith('@g.us')) {
                    try {
                        const metadata = await sock.groupMetadata(chatId);
                        const botNumber = jidNormalizedUser(sock.user.id);
                        const botParticipant = metadata.participants.find(p => p.id === botNumber);
                        isAdmin = (botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin');
                    } catch (e) { mz_log("Erreur récupération metadata:", e.message) }
                }

                const logPrefix = event.isRetroactive ? '[HISTORIQUE]' : '[TEMPS RÉEL]';

                if (isAdmin) {
                    socket.emit('log', `${logPrefix} 🚨 SPAM détecté contre ${sender}`);
                    await sock.sendMessage(chatId, { delete: msg.key });
                    try {
                        await sock.updateBlockStatus(sender, "block");
                        await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                        socket.emit('log', `${logPrefix} 🔨 ${sender} bloqué et expulsé.`);
                    } catch (actionErr) {
                        socket.emit('log', `${logPrefix} ❌ Erreur action contre ${sender}: ${actionErr.message}`);
                    }
                } else {
                    socket.emit('log', `⚠️ Spam détecté de ${sender}, mais le bot n'est PAS Admin ici.`);
                }
            }
        } catch (err) {
            console.error("Erreur lors du traitement d'un message :", err);
        }
    }
}

// =======================
//  SCAN HISTORIQUE
// =======================
async function retroactiveScan(socket) {
    mz_log("retroactiveScan DEB ");
    socket.emit('log', `⏳ Scan historique à partir de ${targetDate.toLocaleTimeString()}...`);

    if (!store || !sock) {
        socket.emit('log', '❌ Store ou socket non prêt.');
        return;
    }

    const chats = store.chats.all();
    mz_log('Chats connus :', chats.map(c => c.id));

    let scanCount = 0;
    for (const chat of chats) {
        const jid = chat.id;
        if (!jid.endsWith('@g.us')) continue;
        try {
            const messages = await sock.fetchMessages({ jid, count: 50 });
            if (messages?.length) {
                await processMessages({ messages, isRetroactive: true }, socket);
                scanCount += messages.length;
            }
        } catch (err) {
            mz_log(`Erreur récupération messages chat ${jid}:`, err.message);
        }
    }

    socket.emit('log', `✅ Scan historique terminé. ${scanCount} messages vérifiés.`);
}

// =======================
//  START BOT
// =======================
async function startBot(socket) {
    mz_log("[BOT] Démarrage du bot");

    if (sock && sock.user) {
        socket.emit('status', { message: 'Bot déjà connecté.', status: 'open' });
        return;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, "auth"));

        const { version } = await fetchLatestBaileysVersion();

        if (sock) {
            try { sock.ws.close(); } catch (e) { }
            sock = null;
        }

        mz_log("[BOT] Création socket Baileys");

        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            auth: state,
            version,
            syncFullHistory: true,
            printQRInTerminal: true
        });

        store = makeInMemoryStore({});
        store.bind(sock.ev);
        sock.ev.on("creds.update", saveCreds);

        let storeLoaded = false;

        // --- EVENTS
        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;
            mz_log("[CONN] Connection update :", connection);

            if (qr) {
                socket.emit('qr-code', qr);
                socket.emit('status', { message: 'Scannez le QR code...', status: 'qr-pending' });
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                

                if (reason !== DisconnectReason.loggedOut && reason !== 401 && reason != 515 ) {
                    socket.emit('status', { message: 'Connexion perdue. Redémarrage dans 10s...', status: 'closed' });
                    mz_log("[CONN] Connection close", reason);

                    retryCount++;
                    if (retryCount <= MAX_RETRIES) {
                        socket.emit('status', { message: `Reconnexion en cours... ${10} s`, status: 'reconnecting' });
                        setTimeout(() => startBot(socket), 10000);
                    } else {
                        socket.emit('status', { message: 'Nombre max de tentatives atteint. Bot arrêté.', status: 'error' });
                        sock = null;
                    }
                } else {
                    socket.emit('log', '❌ Session invalide. Veuillez scanner le QR code.');
                    sock = null;
                }

            } else if (connection === "open") {
                retryCount = 0;
                socket.emit('status', { message: 'Bot connecté. Synchronisation en cours...', status: 'syncing' });
            }
        });

        sock.ev.on('chats.set', async () => {
            if (!storeLoaded) {
                storeLoaded = true;
                socket.emit('status', { message: 'Bot connecté et store synchronisé.', status: 'open' });
                retroactiveScan(socket);
            }
        });

        sock.ev.on("messages.upsert", async (event) => {
            await processMessages(event, socket);
        });

    } catch (err) {
        console.error("❌ ERREUR CRITIQUE DANS startBot :", err);
        socket.emit('status', { message: 'Erreur critique: Échec du chargement de Baileys.', status: 'error' });
    }
}

// =======================
//  SOCKET.IO
// =======================
io.on("connection", (socket) => {
    mz_log("[SOCKET.IO] Client connecté :", socket.id);

    if (sock && sock.user) {
        socket.emit('status', { message: 'Bot connecté et actif.', status: 'open' });
    } else {
        socket.emit('status', { message: 'Bot éteint. Cliquez sur Démarrer.', status: 'closed' });
    }

    socket.on("start-bot", () => startBot(socket));

    socket.on("list-groups", () => {
        if (!store || !sock) {
            socket.emit('log', '❌ Bot non connecté ou store vide.');
            return;
        }
        const groups = store.chats.all()
            .filter(c => c.id.endsWith("@g.us"))
            .map(c => ({ name: c.name || c.id, jid: c.id }));
        socket.emit('groups-list', groups);
    });

    socket.on("scan-group", async ({ jid, startDate }) => {
        if (!sock) { socket.emit('log', '❌ Bot non connecté.'); return; }
        const timestamp = Math.floor(new Date(startDate).getTime() / 1000);
        let lastMessageId = undefined;
        let totalChecked = 0;

        socket.emit('log', `⏳ Scan du groupe ${jid} depuis ${startDate}`);
        while (true) {
            try {
                const messages = await sock.fetchMessages({ jid, count: 50, before: lastMessageId });
                if (!messages?.length) break;

                const filtered = messages.filter(m => {
                    let t = m.messageTimestamp;
                    if (typeof t !== 'number' && t?.low) t = t.low;
                    return t >= timestamp;
                });
                if (!filtered.length) break;

                totalChecked += filtered.length;
                await processMessages({ messages: filtered, isRetroactive: true }, socket);
                lastMessageId = messages[messages.length - 1].key.id;
            } catch (e) { mz_log("Erreur scan-group:", e.message); break; }
        }
        socket.emit('log', `✅ Scan terminé. ${totalChecked} messages vérifiés.`);
    });

    socket.on("logout-bot", async () => {
        if (sock) {
            try { await sock.logout(); } catch { }
        }
        sock = null; store = null;
        socket.emit('log', 'Bot déconnecté.');
        socket.emit('status', { message: 'Déconnecté. Appuyez sur Démarrer.', status: 'logged-out' });
    });

    socket.on("disconnect", () => mz_log("[SOCKET.IO] Client déconnecté :", socket.id));
});

// =======================
//  LANCEMENT DU SERVEUR
// =======================
server.listen(PORT, () => {
    mz_log(`[BOOT] Serveur web prêt sur http://localhost:${PORT}`);
});
