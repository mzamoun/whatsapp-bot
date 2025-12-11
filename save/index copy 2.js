const express = require("express");
const path = require("path");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

let sock;

// Start WhatsApp bot
async function startWabot() {
    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState("auth");

        sock = makeWASocket({
            version,
            printQRInTerminal: true,
            auth: state
        });

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                console.log("Scan this QR code:");
                qrcode.generate(qr, { small: true });
            }

            if (connection === "open") {
                console.log("CONNECTED to WhatsApp !");
            }

            if (connection === "close") {
                console.error("Connection closed, restarting...");
                startWabot();
            }
        });

    } catch (err) {
        console.error("ERROR starting Baileys:", err);
    }
}

startWabot();

// Web search API
app.post("/search", async (req, res) => {
    try {
        const { keywords, startDate, jid } = req.body;

        const keywordList = keywords
            .split("\n")
            .map(k => k.trim().toLowerCase())
            .filter(k => k);

        const startTimestamp = new Date(startDate).getTime();

        const msgPage = await sock.loadMessages(jid, { limit: 5000 });
        const messages = msgPage.messages || [];

        const results = messages
            .map(msg => {
                const text = msg.message?.conversation ||
                             msg.message?.extendedTextMessage?.text ||
                             "";

                const msgTime = Number(msg.messageTimestamp) * 1000;

                const matched = keywordList.some(k =>
                    text.toLowerCase().includes(k)
                );

                return matched && msgTime >= startTimestamp
                    ? {
                        text,
                        sender: msg.key.participant || msg.key.remoteJid,
                        date: new Date(msgTime).toLocaleString()
                    }
                    : null;
            })
            .filter(Boolean);

        res.json({ success: true, results });

    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.toString() });
    }
});

app.listen(3000, () => console.log("Web interface: http://localhost:3000"));
