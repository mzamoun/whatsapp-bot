import { SPAM_TEXT_TO_CHECK } from '../spam/spam.config.mjs';
import { processSpamMessage } from '../spam/spam.processor.mjs';

export function registerBotEvents(sock) {

  // 🔔 MESSAGES ENTRANTS
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');

    if (!isGroup) return;

    // 🔥 APPEL ICI
    try {
      const meta = await sock.groupMetadata(jid);

      const spamResult = await processSpamMessage(
        msg,
        SPAM_TEXT_TO_CHECK,
        meta
      );

      if (spamResult) {
        console.log('⚠️ SPAM détecté :', spamResult);
      }

    } catch (e) {
      console.error('Erreur spam:', e.message);
    }
  });
}
