import { Router } from 'express';
import { startBot } from '../bot/bot.start.mjs';
import { botState } from '../bot/bot.state.mjs';

const router = Router();

router.get('/start', (req, res) => {
  startBot();
  res.json({ ok: true });
});

router.get('/status', (req, res) => {
  res.json({ status: botState.status });
});

export default router;
