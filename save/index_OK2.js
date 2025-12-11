import makeWASocket, {
    DisconnectReason,
    jidNormalizedUser,
    useMultiFileAuthState
} from "@whiskeysockets/baileys";

const SPAM_LINK = "Voici le tout nouveau groupe de partage de conseils en bourse pour 2025";

// --- CONFIGURATION ---
const targetDate = new Date();
targetDate.setHours(15, 30, 0, 0); // 15h30 aujourd'hui
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

console.log(`📅 FILTRE : On cherche les messages après : ${targetDate.toLocaleString()} (TS: ${targetTimestamp})`);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: true,
        // On ignore les statuts pour éviter les erreurs de déchiffrement inutiles
        shouldIgnoreJid: (jid) => jid === 'status@broadcast' 
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        // LOG DEBUG : Pour confirmer que Baileys envoie bien quelque chose
        console.log(`📥 DEBUG: Reçu un paquet de ${messages.length} message(s). Type: ${type}`);

        for (const msg of messages) {
            try {
                if (!msg.message) continue;

                const chatId = msg.key.remoteJid;
                
                // Ignorer les statuts (stories)
                if (chatId === "status@broadcast") continue;

                // Gestion du timestamp (parfois msg.messageTimestamp est un objet Long)
                let messageTime = msg.messageTimestamp;
                if (typeof messageTime !== 'number' && messageTime?.low) {
                    messageTime = messageTime.low;
                }
                
                // Pour le debug, on affiche l'heure du message reçu
                const msgDate = new Date(messageTime * 1000);
                
                // LOG DEBUG COMPARATIF
                // Décommentez la ligne ci-dessous si vous voulez voir tous les messages passés
                // console.log(`🔎 Check msg: ${msgDate.toLocaleTimeString()} vs Target: ${targetDate.toLocaleTimeString()}`);

                if (messageTime < targetTimestamp) {
                    // Message trop vieux, on passe
                    continue; 
                }

                // --- À PARTIR D'ICI, LE MESSAGE EST DANS LA CIBLE ---

                let groupName = "Inconnu";
                let metadata = null;
                
                // Récupération nom de groupe
                if (chatId.endsWith('@g.us')) {
                    try {
                        metadata = await sock.groupMetadata(chatId);
                        groupName = metadata.subject;
                    } catch { 
                        groupName = "Groupe (Non accessible)";
                    }
                }

                // Extraction du texte (plus robuste)
                const text =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    "";

                if (!text) continue;

                const sender = msg.key.participant || msg.key.remoteJid;
                console.log(`✅ [${msgDate.toLocaleString()}] RETENU | ${groupName} : ${text.substring(0, 50)}...`);

                if (text.includes(SPAM_LINK)) {
                    console.log(`🚨 SPAM TROUVÉ ! Action en cours...`);

                    // 1. Alerte
                    await sock.sendMessage(chatId, {
                        text: `🚨 Spam rétroactif détecté !\nUser: ${sender}`
                    });

                    // 2. Modération
                    if (metadata) {
                        const botNumber = jidNormalizedUser(sock.user.id);
                        const botInGroup = metadata.participants.find(p => p.id === botNumber);
                        const isAdmin = botInGroup?.admin;

                        if (isAdmin) {
                            console.log("🛡️ BAN + DELETE");
                            await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                            await sock.sendMessage(chatId, { delete: msg.key });
                        } else {
                            console.log("⚠️ Pas admin, impossible d'agir.");
                        }
                    }
                }

            } catch (err) {
                console.error("Erreur traitement message individuel:", err);
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
            else console.log("❌ Déconnecté (Logged Out).");
        } else if (connection === "open") {
            console.log("✅ Connexion stable. Attente des messages...");
        }
    });

    // Timeout augmenté à 2 minutes pour être sûr
    setTimeout(() => {
        console.log("🏁 Fin du script.");
        process.exit(0);
    }, 120000);
}

startBot();
