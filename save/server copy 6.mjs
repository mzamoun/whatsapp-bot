// --- server.mjs ---
import {
    DisconnectReason,
    jidNormalizedUser,
    makeInMemoryStore,
    makeWASocket,
    useMultiFileAuthState
} from '@whiskeysockets/baileys';
import express from 'express';
import { createServer } from 'http';
import path from 'path';
import pino from 'pino';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// --- LOG UTILE ---
function mz_log(tag, s = '') {
    console.log(`${new Date().toISOString()} [${tag}]`, s);
    return s;
}

// --- VARIABLES GLOBALES ---
const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025";
let sock = null;
let store = null;

// --- FILTRE MESSAGES APRÈS DATE ---
const targetDate = new Date("2025-12-10T00:00:00");
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
mz_log('BOOT', `Filtre messages après ${targetDate.toLocaleString()}`);
mz_log('BOOT', `Serveur web prêt sur http://localhost:${PORT}`);

// --- PROCESS MESSAGES ---
async function processMessages(event, socket) {
    mz_log('BOT', 'processMessages DEB');
    for (const msg of event.messages) {
        try {
            if (!msg.message) continue;

            let messageTime = msg.messageTimestamp;
            if (typeof messageTime !== 'number' && messageTime?.low) {
                messageTime = messageTime.low;
            }
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
                    } catch { }
                }

                const logPrefix = event.isRetroactive ? '[HISTORIQUE]' : '[TEMPS RÉEL]';
                if (isAdmin) {
                    socket.emit('log', `${logPrefix} 🚨 SPAM détecté et actionné contre ${sender}`);
                    await sock.sendMessage(chatId, { delete: msg.key });
                    try {
                        await sock.updateBlockStatus(sender, "block");
                        await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                        socket.emit('log', `${logPrefix} 🔨 ${sender} bloqué et expulsé.`);
                    } catch (actionErr) {
                        socket.emit('log', `${logPrefix} ❌ Erreur d'action contre ${sender}: ${actionErr.message}`);
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

// --- SCAN HISTORIQUE ---
async function retroactiveScan(socket) {
    mz_log('BOT', 'retroactiveScan DEB');
    socket.emit('log', `⏳ Démarrage du scan historique...`);
    if (!store || !sock) {
        socket.emit('log', '❌ Store ou socket non prêt.');
        return;
    }

    const chats = store.chats.all();
    mz_log('BOT', `Chats connus: ${chats.map(c => c.id).join(', ')}`);

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
            console.error(`Erreur récupération messages chat ${jid}:`, err.message);
        }
    }

    socket.emit('log', `✅ Scan historique terminé. ${scanCount} messages vérifiés.`);
}

// --- DEMARRAGE BOT ---
async function startBot(socket) {
    mz_log('BOT', 'Démarrage du bot');
    if (sock && sock.user) {
        let s = mz_log('BOT', 'Le bot est déjà connecté.');
        socket.emit('status', { message: s, status: 'open' });
        return;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(process.cwd(), "auth"));
        mz_log('BOT', 'Auth state prêt');

        sock = makeWASocket({
            logger: pino({ level: 'silent' }),
            syncFullHistory: true,
            printQRInTerminal: false,
            auth: state,
        });

        mz_log('BOT', 'Socket Baileys créé');

        store = makeInMemoryStore({});
        store.bind(sock.ev);

        sock.ev.on("creds.update", saveCreds);

        let storeLoaded = false;

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;
            mz_log('CONN', `Connection update : ${connection}`);

            if (qr) {
                socket.emit('qr', qr); // <-- ENVOI QR CODE AU FRONT
                socket.emit('status', { message: 'Scannez le QR code...', status: 'qr-pending' });
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                if ([DisconnectReason.loggedOut, 401, 515].includes(reason)) {
                    sock = null;
                    socket.emit('status', { message: '❌ Session invalide. Veuillez scanner le QR code.', status: 'closed' });
                } else {
                    socket.emit('status', { message: 'Connexion perdue. Nouvelle tentative dans 10s...', status: 'closed' });
                    setTimeout(() => startBot(socket), 10000);
                }
            } else if (connection === 'open') {
                socket.emit('status', { message: 'Bot connecté. Synchronisation en cours...', status: 'syncing' });
            }
        });

        sock.ev.on('chats.set', () => {
            if (!storeLoaded) {
                storeLoaded = true;
                socket.emit('status', { message: 'Bot connecté. Démarrage du scan historique...', status: 'open' });
                retroactiveScan(socket);
            }
        });

        sock.ev.on('messages.upsert', async (event) => {
            await processMessages(event, socket);
        });

    } catch (err) {
        console.error("❌ ERREUR CRITIQUE DANS startBot :", err);
        socket.emit('status', { message: 'Erreur critique: Échec du chargement de Baileys.', status: 'error' });
    }
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    mz_log('SOCKET.IO', `Client connecté : ${socket.id}`);

    if (sock && sock.user) {
        socket.emit('status', { message: 'Bot connecté et actif.', status: 'open' });
    } else {
        socket.emit('status', { message: 'Bot éteint. Cliquez sur Démarrer.', status: 'closed' });
    }

    socket.on('start-bot', () => startBot(socket));

    socket.on('logout-bot', async () => {
        if (sock) {
            try {
                await sock.logout();
                socket.emit('log', '✅ Déconnexion réussie.');
            } catch (err) {
                socket.emit('log', `⚠️ Erreur lors du logout : ${err.message}`);
            }
        }
        sock = null;
        store = null;
        socket.emit('status', { message: 'Déconnecté. Appuyez sur Démarrer.', status: 'logged-out' });
    });
});

httpServer.listen(PORT, () => {
    mz_log('BOOT', `Serveur web démarré sur http://localhost:${PORT}`);
});
