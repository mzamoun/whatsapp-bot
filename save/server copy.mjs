// ---- server.cjs ----
// WhatsApp Anti-Spam Bot avec Baileys 6.7.0

import baileys from '@whiskeysockets/baileys';
const {
    default: makeWASocket,
    fetchLatestBaileysVersion,
    DisconnectReason,
    useMultiFileAuthState
} = baileys;

import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let sock = null;
let storeReady = false;

// ------------------------------------------------------------------
// LOG vers frontend
function sendLog(msg) {
    console.log(msg);
    io.emit("log", msg);
}

// ------------------------------------------------------------------
// Démarrage du BOT
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");

    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
    });

    // QR CODE
    sock.ev.on("connection.update", (update) => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            io.emit("qr-code", qr);
            io.emit("status", { message: "Scannez le QR", status: "qr-pending" });
        }

        if (connection === "open") {
            storeReady = true;
            io.emit("status", { message: "Connecté", status: "open" });
            sendLog("🔵 Bot connecté !");
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                sendLog("🔴 Déconnecté (logged out)");
                io.emit("status", { message: "Déconnecté", status: "logged-out" });
            } else {
                sendLog("🔴 Connexion perdue, reconnexion...");
                startBot();
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // ------------------ Écoute des messages ----------------------
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg?.message) return;

        const from = msg.key.remoteJid;
        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

        // Détection spam
        const spamLink = "chat.whatsapp.com/F5H9iXq664sIUE73QF6oJz";

        if (text.includes(spamLink)) {
            sendLog(`⚠️ SPAM détecté dans ${from} : ${text}`);

            // Si admin → ban
            try {
                const metadata = await sock.groupMetadata(from);
                const botJid = jidNormalizedUser(sock.user.id);
                const isAdmin = metadata.participants.some(
                    (p) => p.id === botJid && p.admin !== null
                );

                if (isAdmin) {
                    const user = msg.key.participant;
                    sendLog(`🚫 BANNED automatiquement : ${user}`);
                    await sock.groupParticipantsUpdate(from, [user], "remove");
                } else {
                    sendLog("⚠️ Bot n'est pas admin → impossibilité de bannir.");
                }
            } catch (e) {
                sendLog("Erreur ban : " + e);
            }
        }
    });
}

// ------------------------------------------------------------------
// Liste des groupes
async function listGroups() {
    if (!storeReady || !sock) {
        sendLog("❌ Store non prêt.");
        return null;
    }

    const groups = Object.values(sock.chats)
        .filter((c) => c.id.endsWith("@g.us"))
        .map((c) => ({
            name: c.name || c.subject || "Sans nom",
            jid: c.id,
        }));

    return groups;
}

// ------------------------------------------------------------------
// Scan d’un groupe depuis une date donnée
async function scanGroup(jid, startDate) {
    const startMs = new Date(startDate).getTime();
    if (isNaN(startMs)) return [];

    sendLog(`📅 Scan du groupe ${jid} depuis ${startDate}`);

    const messages = await sock.fetchMessages(jid, 200); // ⭐ Baileys 6.7.0 → signature correcte

    const filtered = messages.filter((msg) => {
        const ts = (msg.messageTimestamp || msg.messageTimestampLow) * 1000;
        return ts >= startMs;
    });

    sendLog(`🔍 ${filtered.length} messages trouvés.`);

    return filtered.map((m) => ({
        text:
            m.message?.conversation ||
            m.message?.extendedTextMessage?.text ||
            "",
        user: m.key.participant,
        date: new Date((m.messageTimestamp || m.messageTimestampLow) * 1000),
    }));
}

// ------------------------------------------------------------------
// SOCKET.IO EVENTS
io.on("connection", (socket) => {
    sendLog("Un client est connecté.");

    socket.on("start-bot", () => {
        sendLog("Démarrage du bot demandé...");
        startBot();
    });

    socket.on("logout-bot", async () => {
        try {
            await sock.logout();
            storeReady = false;
            io.emit("status", { message: "Déconnecté", status: "closed" });
        } catch (e) {
            sendLog("Erreur logout : " + e);
        }
    });

    socket.on("list-groups", async () => {
        const groups = await listGroups();
        if (groups) socket.emit("groups-list", groups);
    });

    socket.on("scan-group", async ({ jid, startDate }) => {
        const msgs = await scanGroup(jid, startDate);
        sendLog(JSON.stringify(msgs, null, 2));
    });
});

// ------------------------------------------------------------------

server.listen(3000, () => {
    console.log("Serveur lancé sur http://localhost:3000");
});
