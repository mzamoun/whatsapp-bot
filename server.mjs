import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import express from "express";

import { Boom } from "@hapi/boom";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import fs from "fs";
import http from "http";
import { Server } from "socket.io";
import qrcode from "qrcode"; // Ajout de l'import qrcode manquant

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

// TEXTE DE SPAM À SURVEILLER : les mots cles du spam
const SPAM_TEXT_TO_CHECK = "groupe bourse actions chat whatsapp"

const SPAM_TAB = ["groupe", "bourse", "actions", "chat", "whatsapp"];

/**
 * Vérifie si le texte fourni contient TOUS les mots de la liste SPAM_TAB.
 * La vérification est insensible à la casse.
 * @param {string} text - Le texte à analyser.
 * @param {string[]} spamWords - Le tableau des mots clés requis.
 * @returns {boolean} - Vrai si tous les mots sont trouvés, faux sinon.
 */
function containsAllSpamWords(text, spamWords) {
    if (!text || !spamWords || spamWords.length === 0) {
        return false;
    }

    let tab_spam = spamWords.toLowerCase().split(" ");

    // Convertir le texte en minuscules une seule fois pour une vérification plus rapide
    const lowerCaseText = text.toLowerCase();

    // Vérifier si chaque mot du tableau est présent dans le texte
    for (const word of tab_spam) {
        // Le mot du tableau doit également être mis en minuscules pour la comparaison
        if (!lowerCaseText.includes(word.toLowerCase())) {
            return false; // Dès qu'un mot est manquant, on retourne faux immédiatement
        }
    }

    // Si la boucle se termine, cela signifie que tous les mots ont été trouvés
    return true;
}

/**
 * Retourne la date et l'heure formatées au format jj/mm/aaaa hh:mn:ss.
 * @param {Date} [dateObject] - L'objet Date à formater. Par défaut, utilise l'heure actuelle.
 * @returns {string} La date et l'heure formatées.
 */
function getFormattedDateTime(dateObject) {
    const now = dateObject instanceof Date ? dateObject : new Date();

    const pad = (num) => String(num).padStart(2, '0');

    const day = pad(now.getDate());
    const month = pad(now.getMonth() + 1);
    const year = now.getFullYear();

    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());

    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

/**
 * Charge l'historique d'un groupe à partir d'une date spécifique (utilisé par advanced-scan)
 * @param {string} jid - JID du groupe
 * @param {Date} fromDate - Date minimale
 * @returns {Promise<Array>}
 */
async function fetchMessagesSince(jid, fromDate) {
    let cursor = undefined;
    let results = [];
    let stop = false;

    while (!stop) {
        // NOTE: loadMessages est une méthode expérimentale/moins stable dans Baileys.
        const batch = await sock.loadMessages(jid, 50, cursor);

        if (!batch || batch.length === 0) break;

        for (const msg of batch) {
            const ts = msg.messageTimestamp * 1000;

            if (ts >= fromDate.getTime()) {
                results.push(msg);
            } else {
                stop = true;
                break;
            }
        }

        cursor = { before: batch[0].key, limit: 50 };
    }
    return results;
}

// ... (imports et début du fichier inchangés)

// ... (fonctions utilitaires inchangées)

/**
 * UNIFICATION : Applique les actions de sanction (log, delete, block, kick) à un message spam.
 * @param {string} jid - JID du groupe
 * @param {object} msg - Objet message de Baileys
 * @param {object} meta - GroupMetadata
 * @returns {Promise<string>} Résultat de l'action
 */
async function handleSpamAction(jid, msg, meta) {

    console.log("Message spam detected : msg.key ", msg.key, " jid:", jid)

    const sender = msg.key.participant || msg.key.remoteJid;
    const botJID = sock.user.id; // JID du bot
    let botLID = sock.user.lid;
    botLID = botLID.replace(":80", "");

    console.log("sender :", sender)
    console.log("botLID :", botLID)
    console.log("botJID :", botJID)

    console.log("msg: ", msg)
    console.log("sock.user : ", sock.user)
    // console.log("sock : ", sock )

    // console.log("meta : ", meta )
    console.log("participants : ", meta.participants)
    // console.log("botJID : ", botJID )

    const botParticipant = meta.participants.find(p => p.id === botLID);
    console.log("botParticipant : ", botParticipant)
    const isAdmin = botParticipant && (botParticipant.admin == "superadmin" || botParticipant.admin == "admin" || botParticipant.admin == "true" || botParticipant.isAdmin || botParticipant.isSuperAdmin);
    console.log("isAdmin : ", isAdmin)

    let isSenderBot = (sender === botLID)

    console.log("isSenderBot=", isSenderBot)

    // let msgBot = `🚨 BOT : Auto-SPAM détecté.\nLe message va etre supprimé car Bot est Admin ici.\n`
    let msgBot = `Message spam supprimé par admin.\n`
    // msgBot += `msg.key = ${msg.key}\n jid = ${jid}`
    if(!isAdmin) msgBot = ""

    try {
        // 1. Log dans le groupe (optionnel, pour alerter qu'il s'agit d'un auto-spam)
        // on ne le fait que lorsqu'on est admin afin de ne pas trop spamer !
        if(isAdmin) {
            await sock.sendMessage(jid, {
                text: msgBot
            });

            // 2. Supprimer son propre message
            console.log("av suppresion msg ", msg.key, "jid", jid)
    
            try {
                // msg.key est l'objet Key complet du message reçu
                let x = await sock.sendMessage(jid, { delete: msg.key });
                // action_taken = "Message supprimé.";
                console.log("Message deleted x=", x)
            } catch (e) {
                // action_taken = `Erreur de suppression: ${e.message}`;
                console.log(`Erreur de suppression: ${e.message}`)
            }
        }

        // return "Auto-spam (Bot). Message supprimé uniquement.";
    } catch (e) {
        console.error(`Erreur lors de l'auto-suppression pour ${jid}:`, e.message);
        return "Auto-spam (Bot). Échec de la suppression.";
    }

    // --- 💡 AJOUT DE LA VÉRIFICATION DU BOT ---
    if (isSenderBot) {
        // Le bot ne peut pas se bloquer ou se kicker.
        // Il peut par contre supprimer son propre message.
        // try {
        //     // 1. Log dans le groupe (optionnel, pour alerter qu'il s'agit d'un auto-spam)
        //     await sock.sendMessage(jid, {
        //         text: `🚨 Auto-SPAM détecté (message du bot).\nLe message a été supprimé.`
        //     });
        //     // 2. Supprimer son propre message
        //     await sock.sendMessage(jid, { delete: msg.key });
        //     return "Auto-spam (Bot). Message supprimé uniquement.";
        // } catch (e) {
        //     console.error(`Erreur lors de l'auto-suppression pour ${jid}:`, e.message);
        //     return "Auto-spam (Bot). Échec de la suppression.";
        // }
    }
    // ------------------------------------------

    if (!isAdmin) {
        return "Bot n'est pas administrateur. Aucune action prise.";
    }

    if (!sender) {
        return "Erreur: Expéditeur (sender) manquant. Suppression uniquement.";
    }

    // Récupération du nom de l'expéditeur non-bot
    const senderName = meta.participants.find(p => p.id === sender)?.notify || sender.split('@')[0];

    try {
        // 1. Log dans le groupe
        // await sock.sendMessage(jid, {
        //     text: `🚨 SPAM détecté chez *${senderName}*.\nLe message a été supprimé, utilisateur bloqué et expulsé (si possible).`
        // });

        // 2. Supprimer le message
        await sock.sendMessage(jid, { delete: msg.key });

        if (!isSenderBot) {
            // 3. Bloquer l'utilisateur

            await sock.updateBlockStatus(sender, 'block');
            // 4. KICK (expulser)
            const kickResult = await sock.groupParticipantsUpdate(jid, [sender], "remove");
            const isKicked = kickResult.length > 0 && kickResult[0].status === '200';

            return `Message supprimé, Utilisateur bloqué, Expulsion: ${isKicked ? 'OK' : 'Échec/Non requis'}`;
        }


    } catch (actionError) {
        console.error(`Erreur lors de l'action anti-spam pour ${sender} dans ${jid}:`, actionError.message);
        return `Erreur d'action admin: ${actionError.message}`;
    }
}

// async function handleSpamAction(jid, msg, meta) {
//     // 1. Déterminer les identifiants corrects
//     const sender = msg.key.participant || msg.key.remoteJid;
//     const botJID = sock.user.id; // JID standard du bot

//     // Vérification si l'expéditeur est le bot lui-même
//     const isBotSender = sender === botJID;

//     console.log("-----------------------------------------");
//     console.log("JID Expediteur (Sender): ", sender);
//     console.log("JID Bot (BotJID): ", botJID);
//     console.log("Est le Bot (isBotSender): ", isBotSender);
//     console.log("-----------------------------------------");

//     let action_taken = "Erreur: Suppression échouée.";

//     // 2. Tenter la suppression (action prioritaire)
//     try {
//         await sock.sendMessage(jid, { delete: msg.key });
//         action_taken = "Message supprimé.";
//     } catch (e) {
//         action_taken = `Erreur de suppression: ${e.message}`;
//     }

//     // 3. Traitement de l'Auto-Spam (Si le bot s'est envoyé le message)
//     if (isBotSender) {
//         // Envoi du log de fin (après la suppression)
//         await sock.sendMessage(jid, { 
//             text: `🚨 Auto-SPAM détecté (message du bot).\nRésultat de la suppression: ${action_taken}. (Pas de blocage/kick)` 
//         });
//         return `Auto-spam. ${action_taken}`;
//     }

//     // --- 4. Traitement des messages tiers (Expéditeur n'est pas le bot) ---

//     // Trouver la participation du bot pour vérifier s'il est admin
//     const botParticipant = meta.participants.find(p => p.id === botJID);
//     const isAdmin = botParticipant && (botParticipant.admin === 'admin' || botParticipant.admin === 'superadmin');

//     console.log("isAdmin: ", isAdmin);

//     // Si le bot n'est pas admin, il ne peut rien faire d'autre que le résultat de suppression.
//     if (!isAdmin) {
//         // Envoi du log de fin (si possible)
//         await sock.sendMessage(jid, { text: `🚨 SPAM détecté. Le bot n'est pas administrateur. Aucune action prise.` });
//         return `Bot n'est pas administrateur. ${action_taken}`;
//     }

//     // 5. Actions d'admin pour un expéditeur TIERS (Blocage/Kick)

//     const senderName = meta.participants.find(p => p.id === sender)?.notify || sender.split('@')[0];

//     try {
//         // Log dans le groupe
//         await sock.sendMessage(jid, {
//             text: `🚨 SPAM détecté chez *${senderName}*.\nUtilisateur bloqué et expulsé.`
//         });

//         // 💡 Blocage de l'utilisateur TIERS (sender)
//         await sock.updateBlockStatus(sender, 'block');

//         // KICK (expulser)
//         const kickResult = await sock.groupParticipantsUpdate(jid, [sender], "remove");
//         const isKicked = kickResult.length > 0 && kickResult[0].status === '200';

//         return `${action_taken}, Utilisateur bloqué, Expulsion: ${isKicked ? 'OK' : 'Échec'}.`;
//     } catch (actionError) {
//         console.error(`Erreur lors de l'action admin anti-spam pour ${sender}:`, actionError.message);
//         return `Erreur d'action admin: ${actionError.message}. ${action_taken}`;
//     }
// }

/**
 * UNIFICATION : Traite un message, le vérifie pour le spam et applique les actions si nécessaire.
 * @param {object} msg - Objet message de Baileys
 * @param {string} searchText - Texte à rechercher pour le spam
 * @param {object} meta - GroupMetadata (optionnel, mais nécessaire pour les actions)
 * @returns {Promise<object | null>} L'objet spam trouvé ou null
 */
async function processSpamMessage(msg, searchText, meta = null) {

    if (!searchText) return null;
    if (!msg) return null;

    console.log("msg.key", msg.key)

    const jid = msg.key.remoteJid;
    const timestamp = msg.messageTimestamp;
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    // if (!text || !text.toLowerCase().includes(searchText.toLowerCase())) {
    //     return null; // Pas de spam
    // }

    let tab_spam = searchText.toLowerCase().split(" ");

    if (containsAllSpamWords(text, searchText)) {
        console.log("🚨 SPAM détecté !");
    } else {
        return null;
    }

    const sender = msg.key.participant || msg.key.remoteJid;
    const senderName = meta?.participants.find(p => p.id === sender)?.notify || sender.split('@')[0];
    const groupName = meta?.subject || jid;

    const spamDetails = {
        group_id: jid,
        group_name: groupName,
        sender: sender,
        sender_name: senderName,
        message: text.substring(0, 200) + (text.length > 200 ? '...' : ''),
        timestamp: new Date(timestamp * 1000).toLocaleString(),
        action_taken: 'Aucune action (Admin manquant ou non-scan)'
    };

    if (meta) { // Les actions sont possibles uniquement si on a les metadata (scan)
        spamDetails.isAdmin = meta.participants.some(p => p.id === sock.user.id && (p.isAdmin || p.isSuperAdmin));
        spamDetails.action_taken = await handleSpamAction(jid, msg, meta);
    }

    return spamDetails;
}


/**
 * Anciennement scanGroupForSpam : Scan l'historique d'un groupe à partir d'une date (utilisé par advanced-scan)
 * @param {string} jid - JID du groupe
 * @param {string} searchText - Texte de spam
 * @param {string} startDateString - Date minimale (ISO string)
 * @returns {Promise<object>} { isAdmin: boolean, spamFound: Array }
 */
async function scanGroupMessagesSince(jid, searchText, startDateString) {
    const startDate = new Date(startDateString);
    const meta = await sock.groupMetadata(jid);
    const bot = meta.participants.find(p => p.id === sock.user.id);
    const isAdmin = bot && (bot.isAdmin || bot.isSuperAdmin);

    const spamFound = [];

    // Utilise la fonction fetchMessagesSince optimisée pour l'historique
    const messages = await fetchMessagesSince(jid, startDate);

    for (const msg of messages) {
        const spamResult = await processSpamMessage(msg, searchText, meta);

        if (spamResult) {
            spamFound.push(spamResult);
        }
    }

    return { isAdmin, spamFound };
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
            // browser: ["WhatsApp Bot", "Chrome", "1.0"],
            getMessage: async () => undefined,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            browser: ["Chrome", "Safari", "10.15.7"],
            // 💡 AJOUT : Augmenter le délai d'attente à 60 secondes (60000 ms)
            syncTimeoutMs: 60000,
        });

        sock.ev.on("creds.update", saveCreds);

        // QR & Connection status
        sock.ev.on("connection.update", async (update) => {

            const { qr, connection, lastDisconnect } = update;

            if (qr) {
                // Utilisation de qrcode importé
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
                    setTimeout(() => startBot(), 20000);
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
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
            const senderJid = msg.key.participant || jid;

            // --- Exclure les Newsletters ---
            if (jid.endsWith('@newsletter')) {
                console.log(`[IGNORE] Message provenant d'un canal (Newsletter): ${jid}`);
                return;
            }

            const isGroup = jid.endsWith('@g.us');

            // FILTRAGE JID
            if (monitoredJIDs.length > 0 && !monitoredJIDs.includes(jid)) {
                return;
            }

            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            let gpName = isGroup ? 'Conversation Privée' : '';
            let userNameOfMsg = senderJid;

            let groupMeta = null;

            try {
                // 1. Obtenir le nom de l'envoyeur
                const contact = await sock.presenceSubscribe(senderJid);
                if (sock.contacts[senderJid]?.notify) {
                    userNameOfMsg = sock.contacts[senderJid].notify;
                } else if (sock.contacts[senderJid]?.verifiedName) {
                    userNameOfMsg = sock.contacts[senderJid].verifiedName;
                } else {
                    userNameOfMsg = senderJid.split('@')[0];
                }

                // 2. Obtenir le nom du groupe et les metadata
                if (isGroup) {
                    groupMeta = await sock.groupMetadata(jid);
                    gpName = groupMeta.subject || 'Groupe Inconnu';
                }
            } catch (e) {
                console.error(`Erreur de récupération d'info pour ${jid}: ${e.message}`);
                gpName = isGroup ? 'GROUPE NON ACCESSIBLE' : 'Conversation Privée';
            }


            // AFFICHAGE DU MESSAGE
            const messageUnixTime = msg.messageTimestamp;
            const messageDateObject = new Date(messageUnixTime * 1000);
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

            // -------------------- Détection de spam --------------------

            if (containsAllSpamWords(text, SPAM_TEXT_TO_CHECK) && isGroup) {
                try {
                    if (!groupMeta) {
                        groupMeta = await sock.groupMetadata(jid);
                    }

                    const spamResult = await processSpamMessage(msg, SPAM_TEXT_TO_CHECK, groupMeta);

                    if (spamResult) {
                        console.log("⚠️ SPAM détecté :", spamResult);
                        // Ici, processSpamMessage a déjà appliqué les actions si le bot est admin
                    }
                } catch (spamError) {
                    console.error(`Erreur lors du traitement du spam dans ${jid}:`, spamError.message);
                }
            }
            // -------------------- FIN Détection de spam --------------------



            if (text.toLowerCase() === "ping") {
                await sock.sendMessage(jid, { text: "pong" });
            }
        });

        // Événement de synchronisation des chats
        sock.ev.on("chats.set", ({ isFull, chats, newChats, deleteIDs }) => {
            console.log("****** [SYNC] : isFull : ", isFull, "chats : ", chats?.length, "newChats : ", newChats, "deleteIDs : ", deleteIDs)
            // Si isFull est vrai, cela marque le début ou la fin de la synchronisation initiale massive.
            if (isFull) {

                syncProgress = { current: 0, total: chats.length, status: 'syncing' };
                io.emit("sync.progress", syncProgress);

                const interval = setInterval(() => {
                    if (syncProgress.current < syncProgress.total) {
                        syncProgress.current += Math.ceil(syncProgress.total / 10);
                        if (syncProgress.current > syncProgress.total) {
                            syncProgress.current = syncProgress.total;
                        }
                        io.emit("sync.progress", syncProgress);
                    } else {
                        clearInterval(interval);

                        chatsSynchronized = true;
                        syncProgress.status = 'finished';
                        io.emit("sync.progress", syncProgress);
                        console.log("✔ Synchronisation des chats terminée ! Total:", syncProgress.total);
                    }
                }, 300);

            } else if (newChats || deleteIDs) {
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
        setTimeout(() => startBot(), 20000);
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

    if (!chatsSynchronized) {
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

// Route de scan de spam (limité aux 50 derniers messages)
app.post("/scan-for-spam", async (req, res) => {
    if (!sock || status !== "connected") {
        return res.status(400).json({ error: "Bot non connecté." });
    }

    if (!chatsSynchronized) {
        return res.status(400).json({ error: "Erreur de synchronisation : Veuillez attendre la fin de la synchronisation des chats." });
    }

    const { startDateString, searchText } = req.body;
    if (!searchText) {
        return res.status(400).json({ error: "Le texte de spam est requis." });
    }

    const startTime = startDateString ? new Date(startDateString).getTime() / 1000 : 0;

    let groupsToScan = Object.values(sock.chats).filter(chat => chat.id.endsWith("@g.us"));

    if (monitoredJIDs.length > 0) {
        groupsToScan = groupsToScan.filter(chat => monitoredJIDs.includes(chat.id));
    }
    const spamResults = [];

    for (const chat of groupsToScan) {
        try {
            const meta = await sock.groupMetadata(chat.id);

            // fetchMessages est pour les messages *récents* (50 par défaut)
            const messages = await sock.fetchMessages({
                jid: chat.id,
                count: 50,
            });

            for (const msg of messages) {
                const timestamp = msg.messageTimestamp;

                if (timestamp >= startTime) {
                    // Utilisation de la fonction unifiée
                    const spamResult = await processSpamMessage(msg, searchText, meta);
                    if (spamResult) {
                        spamResults.push(spamResult);
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

// Route de scan de spam AVANCÉ (historique plus profond)
app.post("/advanced-scan", async (req, res) => {
    if (!sock || status !== "connected")
        return res.status(400).json({ error: "Bot non connecté." });

    if (!chatsSynchronized)
        return res.status(400).json({ error: "Chats non synchronisés." });

    const { jid, startDate, spamText } = req.body;

    if (!jid || !jid.endsWith("@g.us"))
        return res.status(400).json({ error: "JID de groupe invalide." });

    if (!spamText)
        return res.status(400).json({ error: "Texte spam manquant." });

    if (!startDate)
        return res.status(400).json({ error: "Date de départ manquante." });

    // Utilisation de la fonction renommée
    const result = await scanGroupMessagesSince(jid, spamText, startDate);

    res.json({
        ok: true,
        jid,
        isAdmin: result.isAdmin,
        spamFound: result.spamFound
    });
});


// ---------------------------------------------------------------------------
// ▶ SOCKET.IO
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
    console.log("Client connecté");
    console.log("socket : ", socket);
    socket.emit("status", status);
    if (qrCodeSVG) socket.emit("qr", qrCodeSVG);
});

// ---------------------------------------------------------------------------
server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});