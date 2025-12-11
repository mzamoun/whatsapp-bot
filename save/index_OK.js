import makeWASocket, {
    DisconnectReason,
    jidNormalizedUser,
    useMultiFileAuthState
} from "@whiskeysockets/baileys";


const SPAM_LINK = "Voici le tout nouveau groupe de partage de conseils en bourse pour 2025";

async function startBot() {

    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        syncFullHistory: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async (event) => {
        try {
            const msg = event.messages[0];
            if (!msg.message) return;

            // ID du groupe
            const chatId = msg.key.remoteJid;

            // Nom du groupe
            const metadata = await sock.groupMetadata(chatId).catch(() => null);
            const groupName = metadata?.subject || "Groupe inconnu";

            // Texte du message
            const text =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "";

            const sender = msg.key.participant || msg.key.remoteJid;

            const now = new Date().toLocaleString();

            console.log(`📌 Groupe : ${groupName} — ${now}`);
            console.log(`👤 ${sender}: ${text}`);

            // Détection du lien spam
            if (text.includes(SPAM_LINK)) {

                console.log(
                    `🚨 SPAM détecté dans ${groupName} — user : ${sender}`
                );

                // Message dans le groupe
                await sock.sendMessage(chatId, {
                    text: `🚨 Le bot a trouvé le spam actuel !\nUtilisateur : ${sender}`
                });

                // Vérification si le bot est admin
                const botNumber = jidNormalizedUser(sock.user.id);
                const botInGroup = metadata.participants.find(
                    (p) => p.id === botNumber
                );

                const isAdmin = botInGroup?.admin !== null;

                if (isAdmin) {
                    console.log("🛡️ Le bot est admin → action de modération...");

                    // 1. Bannir l’utilisateur
                    await sock.groupParticipantsUpdate(
                        chatId,
                        [sender],
                        "remove"
                    );

                    // 2. Supprimer le message
                    await sock.sendMessage(chatId, {
                        delete: msg.key
                    });

                    // 3. Signaler à WhatsApp (optionnel)
                    await sock.sendMessage(chatId, {
                        text: `🔨 User banni et message supprimé.`
                    });

                } else {
                    console.log("⚠️ Le bot N'EST PAS admin → aucune action de modération.");
                }
            }
        } catch (err) {
            console.error("Erreur dans messages.upsert:", err);
        }
    });

    // Lorsque WhatsApp a fini de synchroniser les messages
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                startBot();
            } else {
                console.log("❌ Déconnecté.");
            }
        } else if (connection === "open") {
            const now = new Date().toLocaleString();
            console.log(`✅ Connexion ouverte — ${now}`);
        }
    });

    // Sortir après 20 secondes (lecture terminée)
    setTimeout(() => {
        const now = new Date().toLocaleString();
        console.log(`🏁 Fin lecture WhatsApp — ${now}`);
        process.exit(0);
    }, 20000);
}

startBot();
