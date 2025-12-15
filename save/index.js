import makeWASocket, {
    DisconnectReason,
    jidNormalizedUser,
    useMultiFileAuthState,
} from "@whiskeysockets/baileys";

// 💡 CORRECTION D'IMPORTATION : On importe la fonction pour générer le QR
// On utilise une approche require car l'export peut être mixte.
// Si cela ne fonctionne pas, il faudra passer l'option 'qrMethod' à 'pino' (logging)
import pino from 'pino';

// On utilise pino comme logger, et on retire le qrMethod: QR_CODES.terminal 
// pour laisser Baileys gérer la demande de QR code en interne, ce qui est plus stable 
// dans les dernières versions.

const SPAM_LINK = "nouveau groupe de partage de conseils en bourse pour 2025"; 

// --- CONFIGURATION DE LA DATE (inchangé) ---
const targetDate = new Date();
targetDate.setHours(15, 30, 0, 0); 
const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

console.log(`📅 FILTRE ACTIF : Messages postérieurs à ${targetDate.toLocaleString()}`);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth");
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), // Supprimer les logs excessifs
        // Suppression de qrMethod: QR_CODES.terminal pour laisser la gestion de la connexion par défaut
        // et éviter l'erreur d'importation.
        syncFullHistory: true,
        shouldIgnoreJid: (jid) => jid === 'status@broadcast',
        printQRInTerminal: true, // Réintroduit pour tenter d'obtenir le QR (moins prioritaire que logger)
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
            try {
                if (!msg.message) continue;
                
                let messageTime = msg.messageTimestamp;
                if (typeof messageTime !== 'number' && messageTime?.low) {
                    messageTime = messageTime.low;
                }

                if (messageTime < targetTimestamp) continue;

                const chatId = msg.key.remoteJid;
                
                // Extraction de texte plus robuste
                let text = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || 
                             msg.message.imageMessage?.caption || "";
                
                const normalizedText = text.toLowerCase(); 

                if (!normalizedText) continue;

                // --- DÉTECTION DU SPAM ---
                if (normalizedText.includes(SPAM_LINK.toLowerCase())) {
                    
                    const sender = msg.key.participant || msg.key.remoteJid;
                    let isAdmin = false;
                    
                    if (chatId.endsWith('@g.us')) {
                        try {
                            const metadata = await sock.groupMetadata(chatId);
                            const botNumber = jidNormalizedUser(sock.user.id);
                            const botParticipant = metadata.participants.find(p => p.id === botNumber);
                            
                            isAdmin = (botParticipant?.admin === 'admin' || botParticipant?.admin === 'superadmin');
                        } catch (e) {
                            console.log("⚠️ Impossible de vérifier les droits admin.");
                        }
                    }

                    if (isAdmin) {
                        console.log(`\n🚨 SPAM TROUVÉ (Admin) ! User: ${sender}`);
                        
                        // 1. SUPPRIMER LE MESSAGE
                        await sock.sendMessage(chatId, { delete: msg.key });
                        console.log("🗑️ Message supprimé.");

                        // 2. BLOQUER ET EXPULSER
                        try {
                            await sock.updateBlockStatus(sender, "block");
                            console.log("🚫 Contact bloqué.");
                            await sock.groupParticipantsUpdate(chatId, [sender], "remove");
                            console.log("👋 User expulsé du groupe.");
                        } catch (actionErr) {
                            console.error("❌ Erreur lors du blocage/expulsion :", actionErr);
                        }

                    } else {
                        console.log(`\n⚠️ Spam détecté de ${sender}, mais le bot n'est PAS Admin.`);
                    }
                }

            } catch (err) {
                console.error("Erreur dans la boucle de messages:", err);
            }
        }
    });

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            // Affichage explicite du QR code
            console.log(`\nScannez ce QR code pour vous connecter :\n${qr}\n`);
        }

        if (connection === "close") {
            const reason = lastDisconnect.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log("Connexion perdue. Tentative de reconnexion...");
                startBot();
            } else {
                console.log("❌ Déconnecté (Logged Out).");
            }
        } else if (connection === "open") {
            console.log("\n✅ Connexion ouverte. Analyse des messages en cours...");
        }
    });

    setTimeout(() => {
        console.log("🏁 Fin du script (Timeout atteint).");
        process.exit(0);
    }, 180000); 
}

startBot();
