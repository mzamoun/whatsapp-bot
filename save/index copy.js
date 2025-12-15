import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from "@whiskeysockets/baileys"
import express from "express"
import qrcode from "qrcode-terminal"

const app = express()
app.use(express.json())

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth')

    const { version } = await fetchLatestBaileysVersion()
    console.log("Baileys version:", version)

    const sock = makeWASocket({
        version,
        printQRInTerminal: true,
        auth: state
    })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
        const { qr, connection } = update
        if (qr) {
            console.log("Scan QR Code :")
            qrcode.generate(qr, { small: true })
        }
        if (connection === 'open') console.log("Bot connecté ✔")
        if (connection === 'close') console.log("Bot déconnecté ❌")
    })

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0]
        if (!msg.message) return

        const from = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text

        console.log("📩 Nouveau message : ", text)

        // Exemple : détection mot clé
        if (text && text.includes("test")) {
            await sock.sendMessage(from, { text: "Mot clé détecté !" })
        }
    })
}

startBot()

app.listen(3000, () => console.log("Serveur lancé sur http://localhost:3000"))
