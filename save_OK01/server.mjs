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

app.use(express.json());
app.use(express.text({ type: '*/*' }));
app.use(express.static("public"));

// Déclaration de variables d'état
let sock = null;
let qrCodeSVG = "";
let status = "disconnected";
let isConnecting = false;
let monitoredJIDs = []; // Si vide : tous les groupes. Sinon : liste des JID à surveiller.
let chatsSynchronized = false;
let syncProgress = { current: 0, total: 0, status: 'idle' }; // {current: i, total: 300, status: 'syncing'}

// Dossier d'authentification obligatoire
const AUTH_FOLDER = "./auth";

// server.mjs - Mise à jour de la fonction getFormattedDateTime

/**
 * Retourne la date et l'heure formatées au format jj/mm/aaaa hh:mn:ss.
 * @param {Date} [dateObject] - L'objet Date à formater. Par défaut, utilise l'heure actuelle.
 * @returns {string} La date et l'heure formatées.
 */
function getFormattedDateTime(dateObject) {
    const now = dateObject instanceof Date ? dateObject : new Date(); // Utilise l'objet passé ou l'heure actuelle

    // Fonction d'aide pour ajouter un zéro initial (padding)
    const pad = (num) => String(num).padStart(2, '0');

    // Date
    const day = pad(now.getDate());
    const month = pad(now.getMonth() + 1); // getMonth() retourne 0 pour Janvier
    const year = now.getFullYear();

    // Heure
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

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
            getMessage: async () => undefined,
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

        // Messages entrants
        // Messages entrants (mis à jour pour afficher Nom du Groupe et Nom de l'utilisateur)
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const senderJid = msg.key.participant || jid; // JID de l'envoyeur (essentiel en groupe)
            const isGroup = jid.endsWith('@g.us'); // Vérifier si c'est un groupe

            // FILTRAGE JID
            if (monitoredJIDs.length > 0 && !monitoredJIDs.includes(jid)) {
                return;
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            let gpName = isGroup ? 'Conversation Privée' : '';
            let userNameOfMsg = senderJid; // JID par défaut

            try {
                // 1. Obtenir le nom de l'envoyeur
                // Utiliser le nom du contact si disponible, sinon le JID
                const contact = await sock.presenceSubscribe(senderJid); // S'assurer que le contact est dans le cache
                if (sock.contacts[senderJid]?.notify) {
                    userNameOfMsg = sock.contacts[senderJid].notify;
                } else if (sock.contacts[senderJid]?.verifiedName) {
                    userNameOfMsg = sock.contacts[senderJid].verifiedName;
                } else {
                    // Si aucune information, utiliser une partie du JID
                    userNameOfMsg = senderJid.split('@')[0];
                }

                // 2. Obtenir le nom du groupe
                if (isGroup) {
                    // groupMetadata récupère les infos du groupe
                    const metadata = await sock.groupMetadata(jid);
                    gpName = metadata.subject || 'Groupe Inconnu';
                }
            } catch (e) {
                // Gérer les erreurs de récupération (ex: groupe quitté ou JID invalide)
                console.error(`Erreur de récupération d'info pour ${jid}: ${e.message}`);
                gpName = isGroup ? 'GROUPE NON ACCESSIBLE' : 'Conversation Privée';
            }


            // NOUVEAU FORMAT D'AFFICHAGE
            const messageUnixTime = msg.messageTimestamp; // Timestamp en secondes
            const messageDateObject = new Date(messageUnixTime * 1000); // Conversion en millisecondes
            const now = getFormattedDateTime(messageDateObject);

            console.log("==============================")
            console.log("====NEW MSG FROM : === " + now)
            if (isGroup) {
                console.log(`[MSG] [${jid}] [(${gpName})] : [${userNameOfMsg}] `);
            } else {
                console.log(`[MSG] [${jid}] : [${userNameOfMsg}] `);
            }
            console.log("==========================================================================")
            console.log(`${text}`);
            console.log("==========================================================================")


            if (text.toLowerCase() === "ping") {
                await sock.sendMessage(jid, { text: "pong" });
            }
        });

        // Événement de synchronisation des chats
        // sock.ev.on("chats.set", () => {
        //     chatsSynchronized = true;
        //     console.log("✔ Synchronisation des chats terminée !");
        //     io.emit("status", status + " (Synchronisé)"); // Optionnel, pour le statut
        // });

        // server.mjs - Dans startBot, après sock.ev.on("messages.upsert", ...)

        // Événement de synchronisation des chats
        sock.ev.on("chats.set", ({ isFull, chats, newChats, deleteIDs }) => {
            // Si isFull est vrai, cela marque le début ou la fin de la synchronisation initiale massive.
            if (isFull) {

                syncProgress = { current: 0, total: chats.length, status: 'syncing' };
                io.emit("sync.progress", syncProgress); // Émet le début

                // Simuler la progression (Baileys ne donne pas le i/n pendant la synchro initiale)
                // Nous savons que tous les chats sont reçus d'un coup.
                // On va juste attendre un moment pour simuler le traitement local.

                const interval = setInterval(() => {
                    if (syncProgress.current < syncProgress.total) {
                        // Nous incrémentons par pas pour simuler l'avancement
                        syncProgress.current += Math.ceil(syncProgress.total / 10);
                        if (syncProgress.current > syncProgress.total) {
                            syncProgress.current = syncProgress.total;
                        }
                        io.emit("sync.progress", syncProgress);
                    } else {
                        clearInterval(interval);

                        // FIN DE SYNCHRONISATION
                        chatsSynchronized = true;
                        syncProgress.status = 'finished';
                        io.emit("sync.progress", syncProgress);
                        console.log("✔ Synchronisation des chats terminée ! Total:", syncProgress.total);
                    }
                }, 300); // Met à jour l'affichage toutes les 300ms

            } else if (newChats || deleteIDs) {
                // Mise à jour incrémentielle (après la synchro initiale)
                if (chats.length > 0) {
                    console.log(`Mise à jour incrémentielle des chats : +${newChats?.length || 0} / -${deleteIDs?.length || 0}`);
                }
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

app.get("/start", async (req, res) => {
    if (sock && sock.user || isConnecting) {
        return res.json({ ok: true, message: "Déjà connecté ou en cours de connexion." });
    }
    startBot();
    res.json({ ok: true, message: "Démarrage initié." });
});

app.get("/status", (req, res) => {
    res.json({ status });
});

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

// Route de listage des groupes
app.get("/groups", async (req, res) => {
    if (!sock || status !== "connected") return res.json({ groups: [], monitored: monitoredJIDs, error: "Bot non connecté." });

    // CORRECTION : Vérification de la synchronisation des chats
    if (!chatsSynchronized) { // <-- Vérifie la variable d'état
        return res.status(400).json({ error: "Erreur de synchronisation : Veuillez attendre la fin de la synchronisation des chats." });
    }

    try {
        const groupMetadata = await sock.groupFetchAllParticipating();

        const groups = Object.values(groupMetadata).map((meta, index) => ({
            num: index + 1,
            id: meta.id,
            name: meta.subject,
            size: meta.participants.length,
            isMonitored: monitoredJIDs.includes(meta.id)
        }));

        res.json({ groups: groups, monitored: monitoredJIDs });

    } catch (e) {
        console.error("Erreur lors de la récupération des groupes:", e);
        res.status(500).json({ error: "Erreur serveur lors de l'accès aux groupes." });
    }
});

// Route pour définir le filtre JID
app.post("/set-monitoring-groups", (req, res) => {
    const rawText = req.body || '';
    const jids = rawText.split('\n')
        .map(line => line.trim())
        .filter(jid => jid.length > 0 && jid.includes('@g.us'));

    monitoredJIDs = jids;
    console.log(`[FILTER] Groupes monitorés mis à jour : ${monitoredJIDs.length > 0 ? monitoredJIDs.join(', ') : 'TOUS'}`);
    res.json({ ok: true, count: monitoredJIDs.length });
});

// Route de scan de spam
app.post("/scan-for-spam", async (req, res) => {
    if (!sock || status !== "connected") {
        return res.status(400).json({ error: "Bot non connecté." });
    }

    // CORRECTION : Vérification de la synchronisation des chats
    if (!chatsSynchronized) { // <-- Vérifie la variable d'état
        return res.status(400).json({ error: "Erreur de synchronisation : Veuillez attendre la fin de la synchronisation des chats." });
    }

    const { startDateString, searchText } = req.body;
    if (!searchText) {
        return res.status(400).json({ error: "Le texte de spam est requis." });
    }

    const startTime = startDateString ? new Date(startDateString).getTime() / 1000 : 0;

    // Maintenant, sock.chats est garanti d'être initialisé
    let groupsToScan = Object.values(sock.chats).filter(chat => chat.id.endsWith("@g.us"));

    // Si le filtre JID est actif, on limite le scan à ces JIDs
    if (monitoredJIDs.length > 0) {
        groupsToScan = groupsToScan.filter(chat => monitoredJIDs.includes(chat.id));
    }
    const spamResults = [];

    for (const chat of groupsToScan) {
        try {
            const meta = await sock.groupMetadata(chat.id);
            const botParticipant = meta.participants.find(p => p.id === sock.user.id);
            const isAdmin = botParticipant && (botParticipant.isAdmin || botParticipant.isSuperAdmin);

            const messages = await sock.fetchMessages({
                jid: chat.id,
                count: 50,
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
