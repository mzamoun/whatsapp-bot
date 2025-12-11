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

// Assurez-vous que le dossier 'public' existe pour l'HTML
app.use(express.static("public"));

// Déclaration de variables d'état
let sock = null;
let qrCodeSVG = "";
let status = "disconnected";
let isConnecting = false; // Verrou pour éviter les démarrages multiples

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
    
    // Assurer que le dossier d'authentification existe
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
            auth: state, // Utilisation directe de l'état
            version,
            browser: ["WhatsApp Bot", "Chrome", "1.0"], // Recommandé
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
                // Utilisation de Boom pour analyser la raison de la déconnexion
                const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;

                console.log("❌ Connection fermée. Raison:", lastDisconnect?.error?.message, " | Reconnexion:", shouldReconnect ? "Oui" : "Non");

                status = "disconnected";
                isConnecting = false;
                io.emit("status", status);
                qrCodeSVG = "";
                io.emit("qr", "");

                // Tenter de reconnecter si la déconnexion n'est pas permanente
                if (shouldReconnect) {
                    console.log("Tentative de redémarrage du bot après 5 secondes...");
                    setTimeout(() => startBot(), 5000);
                } else {
                    // Si la déconnexion est due à LOGGED_OUT, on supprime l'auth
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

        // Messages
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const jid = msg.key.remoteJid;
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
        // Intercepter les erreurs d'initialisation (e.g., Connection Failure initial)
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
    // Empêcher les démarrages multiples si la connexion est en cours
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
    // Suppression du dossier d'authentification
    try {
        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    } catch (e) {
        console.error("Erreur lors de la suppression du dossier auth:", e);
    }

    if (sock) {
        try {
            // Tenter de déconnecter proprement, mais ignorer si déjà fermé
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

// Récupération des groupes
app.get("/groups", async (req, res) => {
    if (!sock || status !== "connected") {
        return res.json([]);
    }

    try {
        // Méthode standard pour récupérer tous les groupes actifs
        const groupMetadata = await sock.groupFetchAllParticipating();
        
        const groups = Object.values(groupMetadata).map(meta => ({
            id: meta.id,
            name: meta.subject,
            size: meta.participants.length,
        }));
        
        res.json(groups);

    } catch (e) {
        console.error("Erreur lors de la récupération des groupes:", e);
        res.status(500).json({ error: "Erreur serveur lors de l'accès aux groupes." });
    }
});

// ---------------------------------------------------------------------------
// ▶ SOCKET.IO
// ---------------------------------------------------------------------------
io.on("connection", (socket) => {
    console.log("Client connecté");
    // Envoie l'état actuel au nouveau client
    socket.emit("status", status);
    if (qrCodeSVG) socket.emit("qr", qrCodeSVG);
});

// ---------------------------------------------------------------------------
server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
