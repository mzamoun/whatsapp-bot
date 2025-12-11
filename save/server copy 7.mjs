// server.mjs
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';

// --- Baileys v6.7.0 ---
import {
    jidNormalizedUser,
    makeInMemoryStore,
    makeWASocket,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';

// --- CONFIGURATION DU SERVEUR ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

function mz_log(s) {
    const msg = `[${new Date().toISOString()}] ${s}`;
    console.log(msg);
    io.emit('log', msg);
    return msg;
}

// --- VARIABLES GLOBALES ---
const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025";
let sock = null;
let store = null;
let reconnectTimeout = null;

// --- FILTRE MESSAGES ---
const targetDate = new Date("2025-12-10T00:00:00");
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
mz_log(`[BOOT] Filtre messages après ${targetDate.toLocaleString()}`);
mz_log(`[BOOT] Serveur web prêt sur http://localhost:${PORT}`);

// --- TRAITEMENT MESSAGES ---
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
                    } catch {}
                }

                if (isAdmin) {
                    const logPrefix = event.isRetroactive ? '[HISTORIQUE]' : '[TEMPS RÉEL]';
                    socket.emit('log', `${logPrefix} 🚨 SPAM détecté : ${sender}`);
                    await sock.sendMessage(chatId, { delete: msg.key });
                    try {
                        await sock.updateBlockStatus(sender, "block");
                        await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                        socket.emit('log', `${logPrefix} 🔨 ${sender} bloqué et expulsé.`);
                    } catch (err) {
                        socket.emit('log', `${logPrefix} ❌ Erreur action ${sender}: ${err.message}`);
                    }
                } else {
                    socket.emit('log', `⚠️ Spam détecté de ${sender}, bot PAS Admin.`);
                }
            }
        } catch (err) {
            mz_log("Erreur processMessages: " + err.message);
        }
    }
}

// --- SCAN HISTORIQUE ---
async function retroactiveScan(socket) {
    socket.emit('log', `⏳ Scan historique à partir de ${targetDate.toLocaleTimeString()}...`);
    if (!store || !sock) return socket.emit('log', '❌ Store ou socket non prêt.');

    const chats = store.chats.all();
    mz_log('Chats connus : ' + chats.map(c => c.id).join(', '));

    let scanCount = 0;
    for (const chat of chats) {
        if (!chat.id.endsWith('@g.us')) continue;
        try {
            const messages = await sock.fetchMessages({ jid: chat.id, count: 50 });
            if (messages?.length) {
                await processMessages({ messages, isRetroactive: true }, socket);
                scanCount += messages.length;
            }
        } catch (err) {
            mz_log(`Erreur récupération messages chat ${chat.id}: ${err.message}`);
        }
    }
    socket.emit('log', `✅ Scan historique terminé. ${scanCount} messages vérifiés.`);
}

// --- START BOT ---
async function startBot(socket) {
    if (sock && sock.user) {
        return socket.emit('status', { message: 'Bot déjà connecté.', status: 'open' });
    }
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), "auth"));
        mz_log("[BOT] Auth state prêt");

        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            syncFullHistory: true,
            shouldIgnoreJid: jid => jid === 'status@broadcast',
            printQRInTerminal: false,
            auth: state,
        });

        mz_log("[BOT] Socket Baileys créé");

        store = makeInMemoryStore({});
        store.bind(sock.ev);

        sock.ev.on("creds.update", saveCreds);

        let storeLoaded = false;

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;
            mz_log(`[CONN] Connection update : ${connection || ''}`);

            if (qr) {
                // Générer QR code en base64 pour navigateur
                const qrDataUrl = await qrcode.toDataURL(qr);
                socket.emit('qr-code', qrDataUrl);
                socket.emit('status', { message: 'Scannez le QR code...', status: 'qr-pending' });
            }

            if (connection === "close") {
                const reason = lastDisconnect?.error?.output?.statusCode;
                mz_log(`Connection close ${reason}`);
                socket.emit('status', { message: `Connexion perdue (${reason}). Redémarrage...`, status: 'closed' });
                sock = null;
                if (reconnectTimeout) clearTimeout(reconnectTimeout);
                reconnectTimeout = setTimeout(() => startBot(socket), 10000);
            } else if (connection === "open") {
                socket.emit('status', { message: 'Bot connecté. Synchronisation en cours...', status: 'syncing' });
            }
        });

        sock.ev.on('chats.set', async () => {
            if (!storeLoaded) {
                storeLoaded = true;
                socket.emit('status', { message: 'Bot connecté. Synchronisation terminée.', status: 'open' });
                retroactiveScan(socket);
            }
        });

        sock.ev.on("messages.upsert", async (event) => {
            await processMessages(event, socket);
        });

    } catch (err) {
        mz_log("[ERROR] startBot: " + err.message);
        socket.emit('status', { message: 'Erreur critique: Échec du chargement de Baileys.', status: 'error' });
    }
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    mz_log(`[SOCKET.IO] Client connecté : ${socket.id}`);
    socket.emit('status', sock?.user ? { message: 'Bot connecté.', status: 'open' } : { message: 'Bot éteint. Cliquez sur Démarrer.', status: 'closed' });

    socket.on('start-bot', () => {
        mz_log("[ACTION] Démarrage du bot...");
        startBot(socket);
    });

    socket.on('logout-bot', async () => {
        if (sock) await sock.logout().catch(e => mz_log(e.message));
        sock = null;
        store = null;
        socket.emit('status', { message: 'Bot déconnecté.', status: 'logged-out' });
        mz_log("[LOGOUT] Bot déconnecté");
    });

    socket.on('list-groups', () => {
        if (!store || !sock) return socket.emit('log', '❌ Bot non prêt.');
        const groups = store.chats.all().filter(c => c.id.endsWith('@g.us')).map(c => ({ name: c.name || c.id, jid: c.id }));
        socket.emit('groups-list', groups);
        mz_log("[ACTION] Liste des groupes envoyée au client");
    });

    socket.on('scan-group', async ({ jid, startDate }) => {
        if (!sock) return socket.emit('log', '❌ Bot non connecté.');
        const timestamp = Math.floor(new Date(startDate).getTime() / 1000);
        let lastMessageId = undefined;
        let totalChecked = 0;

        socket.emit('log', `⏳ Scan du groupe ${jid} depuis ${startDate}...`);
        while (true) {
            try {
                const messages = await sock.fetchMessages({ jid, count: 50, before: lastMessageId });
                if (!messages?.length) break;
                const filtered = messages.filter(m => (typeof m.messageTimestamp === 'number' ? m.messageTimestamp : m.messageTimestamp?.low) >= timestamp);
                if (!filtered.length) break;
                totalChecked += filtered.length;
                await processMessages({ messages: filtered, isRetroactive: true }, socket);
                lastMessageId = messages[messages.length - 1].key.id;
            } catch (err) { break; }
        }
        socket.emit('log', `✅ Scan terminé. ${totalChecked} messages vérifiés.`);
    });

    socket.on('disconnect', () => mz_log(`[SOCKET.IO] Client déconnecté : ${socket.id}`));
});

// --- SERVEUR ---
httpServer.listen(PORT, () => {
    mz_log(`[BOOT] Serveur web démarré sur http://localhost:${PORT}`);
});
