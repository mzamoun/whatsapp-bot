import { botState } from '../bot/bot.state.mjs';
import { processSpamMessage } from '../spam/spam.processor.mjs';

router.post('/scan-for-spam', async (req, res) => {
  const { searchText } = req.body;

  const results = [];

  for (const chat of Object.values(botState.sock.chats)) {
    if (!chat.id.endsWith('@g.us')) continue;

    const meta = await botState.sock.groupMetadata(chat.id);
    const messages = await botState.sock.fetchMessages({
      jid: chat.id,
      count: 50
    });

    for (const msg of messages) {
      const spam = await processSpamMessage(msg, searchText, meta);
      if (spam) results.push(spam);
    }
  }

  res.json({ ok: true, results });
});
