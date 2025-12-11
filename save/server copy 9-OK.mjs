import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import express from "express";

import { Boom } from "@hapi/boom";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import fs from "fs";
import http from "http";
import qrcode from "qrcode";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Middleware pour Express
app.use(express.json()); // Nécessaire pour les POST JSON (scan-for-spam)
// Ajout de 'express.text' pour lire le corps de la requête du textarea (set-monitoring-groups)
app.use(express.text({ type: '*/*' }));
app.use(express.static("public"));

// Déclaration de variables d'état
let sock = null;
let qrCodeSVG = "";
let status = "disconnected";
let isConnecting = false;
let monitoredJIDs = []; // Si vide : tous les groupes. Sinon : liste des JID à surveiller.

// Dossier d'authentification obligatoire
const AUTH_FOLDER = "./auth";

// ---------------------------------------------------------------------------
// ▶ LANCER le bot
// ---------------------------------------------------------------------------
async function startBot() {
    if (isConnecting) {
        console.log("⚠️ Le bot est déjà en cours de connexion/démarrage.");
        return;
    }

    isConnecting = true;

    if (!fs.existsSync(AUTH_FOLDER)) {
        fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        status = "connecting";
        io.emit("status", status);

        sock = makeWASocket({
            printQRInTerminal: false,
            auth: state,
            version,
            browser: ["WhatsApp Bot", "Chrome", "1.0"],
        });

        sock.ev.on("creds.update", saveCreds);

        // QR & Connection status
        sock.ev.on("connection.update", async (update) => {
            const { qr, connection, lastDisconnect } = update;

            if (qr) {
                qrCodeSVG = await qrcode.toDataURL(qr);
                io.emit("qr", qrCodeSVG);
                console.log("QR Code généré. Scannez-le pour vous connecter.");
            }

            if (connection === "close") {
                const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

                console.log("❌ Connection fermée. Raison:", lastDisconnect?.error?.message, " | Reconnexion:", shouldReconnect ? "Oui" : "Non");

                status = "disconnected";
                isConnecting = false;
                io.emit("status", status);
                qrCodeSVG = "";
                io.emit("qr", "");

                if (shouldReconnect) {
                    console.log("Tentative de redémarrage du bot après 5 secondes...");
                    setTimeout(() => startBot(), 5000);
                } else {
                    console.log("Déconnexion permanente (Logged Out). Suppression de l'authentification.");
                    try {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    } catch (e) {
                        console.error("Erreur lors de la suppression du dossier auth:", e);
                    }
                    sock = null;
                }
            }

            if (connection === "open") {
                console.log("✔ Connecté");
                status = "connected";
                isConnecting = false;
                io.emit("status", status);
                qrCodeSVG = "";
                io.emit("qr", "");
            }
        });

        // Messages entrants (inclut le filtrage JID et la détection de spam en temps réel)
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;

            // --------------------- FILTRAGE JID (POINT 2) ---------------------
            if (monitoredJIDs.length > 0 && !monitoredJIDs.includes(jid)) {
                return; // Ignorer ce message si le JID n'est pas dans la liste
            }
            // ------------------------------------------------------------------

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            console.log(`[MSG] ${jid} → ${text}`);

            if (text.toLowerCase() === "ping") {
                await sock.sendMessage(jid, { text: "pong" });
            }
        });

    } catch (e) {
        console.error("🛑 Erreur critique lors de l'initialisation ou de la connexion:", e.message);

        status = "disconnected";
        isConnecting = false;
        io.emit("status", status);
        io.emit("qr", "");
        sock = null;

        console.log("Tentative de redémarrage après 10 secondes...");
        setTimeout(() => startBot(), 10000);
    }
}

// ---------------------------------------------------------------------------
// ▶ ROUTES WEB
// ---------------------------------------------------------------------------

// Route de démarrage
app.get("/start", async (req, res) => {
    if (sock && sock.user || isConnecting) {
        return res.json({ ok: true, message: "Déjà connecté ou en cours de connexion." });
    }
    startBot();
    res.json({ ok: true, message: "Démarrage initié." });
});

// Route d'état
app.get("/status", (req, res) => {
    res.json({ status });
});

// Route de déconnexion
app.get("/logout", (req, res) => {
    try {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    } catch (e) {
        console.error("Erreur lors de la suppression du dossier auth:", e);
    }

    if (sock) {
        try {
            sock.logout();
        } catch (e) {
            console.log("Le socket était déjà fermé ou déconnecté lors du logout.");
        }
        sock = null;
    }

    status = "disconnected";
    isConnecting = false;
    io.emit("status", status);
    io.emit("qr", "");

    res.json({ ok: true });
});

// Route de listage des groupes (Point 1)
app.get("/groups", async (req, res) => {
    // Retourne aussi monitoredJIDs pour afficher le statut du filtre côté client
    if (!sock || status !== "connected") return res.json({ groups: [], monitored: monitoredJIDs });

    // Ajout de la vérification pour garantir que Baileys a chargé les données
    // if (!sock.chats) {
    //     return res.status(400).json({ error: "Les données de connexion ne sont pas encore synchronisées. Veuillez réessayer dans quelques instants." });
    // }

    try {
        const groupMetadata = await sock.groupFetchAllParticipating();

        const groups = Object.values(groupMetadata).map((meta, index) => ({
            num: index + 1, // NUM
            id: meta.id,    // JID
            name: meta.subject, // NOM
            size: meta.participants.length, // NB_MEMBRES
            isMonitored: monitoredJIDs.includes(meta.id)
        }));

        res.json({ groups: groups, monitored: monitoredJIDs });

    } catch (e) {
        console.error("Erreur lors de la récupération des groupes:", e);
        res.status(500).json({ error: "Erreur serveur lors de l'accès aux groupes." });
    }
});

// Route pour définir le filtre JID (Point 2)
app.post("/set-monitoring-groups", (req, res) => {
    // req.body est traité comme texte pur grâce à express.text
    const rawText = req.body || '';
    const jids = rawText.split('\n')
        .map(line => line.trim())
        .filter(jid => jid.length > 0 && jid.includes('@g.us')); // Filtre pour JID de groupe

    monitoredJIDs = jids;
    console.log(`[FILTER] Groupes monitorés mis à jour : ${monitoredJIDs.length > 0 ? monitoredJIDs.join(', ') : 'TOUS'}`);
    res.json({ ok: true, count: monitoredJIDs.length });
});

// Route de scan de spam (Point 3)
app.post("/scan-for-spam", async (req, res) => {
    if (!sock || status !== "connected") {
        return res.status(400).json({ error: "Bot non connecté." });
    }

    const { startDateString, searchText } = req.body;
    if (!searchText) {
        return res.status(400).json({ error: "Le texte de spam est requis." });
    }

    // Convertir la date de début en timestamp Baileys (secondes)
    const startTime = startDateString ? new Date(startDateString).getTime() / 1000 : 0;

    // On s'assure que sock.chats existe et est un objet
    if (!sock.chats) {
        return res.status(400).json({ error: "Erreur de synchronisation : Les données des chats ne sont pas encore chargées." });
    }

    // Maintenant, nous pouvons appeler Object.values en toute sécurité
    const groupsToScan = Object.values(sock.chats).filter(chat => chat.id.endsWith("@g.us"));
    const spamResults = [];

    // NOTE: Baileys ne fournit pas d'API simple pour scanner l'historique complet sans base de données.
    // Cette fonction est limitée à la recherche des 50 derniers messages chargés en mémoire par groupe.

    for (const chat of groupsToScan) {
        try {
            const meta = await sock.groupMetadata(chat.id);
            const botParticipant = meta.participants.find(p => p.id === sock.user.id);
            const isAdmin = botParticipant && (botParticipant.isAdmin || botParticipant.isSuperAdmin);

            const messages = await sock.fetchMessages({
                jid: chat.id,
                count: 50, // Limite à 50 messages
            });

            for (const msg of messages) {
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
                const timestamp = msg.messageTimestamp;

                if (timestamp >= startTime && text.toLowerCase().includes(searchText.toLowerCase())) {

                    const sender = msg.key.participant || msg.key.remoteJid;
                    const senderName = meta.participants.find(p => p.id === sender)?.id || sender;

                    const result = {
                        group_name: meta.subject,
                        sender: sender,
                        message: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
                        timestamp: new Date(timestamp * 1000).toLocaleString(),
                        isAdmin: isAdmin
                    };
                    spamResults.push(result);

                    // --- ACTIONS D'ADMIN ---
                    if (isAdmin) {
                        try {
                            // 1. Log dans le groupe
                            await sock.sendMessage(chat.id, { text: `ALERTE SPAM: Message de ${senderName} détecté et traité. (Texte recherché: "${searchText}")` });

                            // 2. Supprimer le message
                            await sock.sendMessage(chat.id, { delete: msg.key });

                            // 3. Bloquer l'utilisateur
                            if (sender) {
                                await sock.updateBlockStatus(sender, 'block');
                            }
                            result.action_taken = `Supprimé, Utilisateur ${sender ? 'bloqué' : 'non bloqué (JID manquant)'}`;
                        } catch (actionError) {
                            result.action_taken = `Erreur d'action admin: ${actionError.message}`;
                        }
                    } else {
                        result.action_taken = "Bot n'est pas administrateur. Aucune action prise.";
                    }
                }
            }
        } catch (e) {
            console.error(`Erreur lors du scan du groupe ${chat.id}:`, e.message);
        }
    }

    res.json({
        ok: true,
        results: spamResults,
        warning: "Le scan est limité aux 50 derniers messages par groupe sans base de données.",
        monitored: monitoredJIDs.length > 0 ? monitoredJIDs.join(', ') : 'TOUS'
    });
});


// ---------------------------------------------------------------------------
// ▶ SOCKET.IO
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
    console.log("Client connecté");
    socket.emit("status", status);
    if (qrCodeSVG) socket.emit("qr", qrCodeSVG);
});

// ---------------------------------------------------------------------------
server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
