import express from 'express';
import http from 'http';
import { Server } from 'socket.io';

import { initSocket } from './bot/bot.state.mjs';
import botRoutes from './routes/bot.routes.mjs';
import groupRoutes from './routes/groups.routes.mjs';
import scanRoutes from './routes/scan.routes.mjs';

const app = express();

app.use(express.json());
app.use(express.text({ type: '*/*' }));
app.use(express.static('public'));

app.use(botRoutes);
app.use(groupRoutes);
app.use(scanRoutes);

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

initSocket(io);

export default app;
