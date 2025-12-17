import { createServer } from 'http';
import app from './app.mjs';

const server = createServer(app);

server.listen(3000, () => {
  console.log('🚀 Server running on http://localhost:3000');
});
