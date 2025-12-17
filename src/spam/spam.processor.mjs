import { handleSpamAction } from './spam.actions.mjs';
import { containsAllWordsOfOneLine } from './spam.matcher.mjs';

export async function processSpamMessage(msg, spamText, meta) {
  if (!msg || !spamText) return null;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    '';

  if (!containsAllWordsOfOneLine(text, spamText)) return null;

  const jid = msg.key.remoteJid;

  return {
    jid,
    action_taken: meta
      ? await handleSpamAction(jid, msg, meta)
      : 'Aucune action'
  };
}
