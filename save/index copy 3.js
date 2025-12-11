import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import express from "express";
import pino from "pino";

const app = express();

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: "silent" })
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "close") {
            const reason = new DisconnectReason(lastDisconnect?.error)?.toString();
            console.log("Connection closed. Reason:", reason);
            startBot();
        } else if (connection === "open") {
            console.log("Bot connected !");
        }
    });
}

startBot();

app.listen(3000, () => console.log("Server running on port 3000"));
