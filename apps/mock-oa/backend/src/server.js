import { createApp } from './app.js';

const port = Number(process.env.MOCK_OA_PORT ?? 3000);
const server = createApp().listen(port, () => {
  console.log(`Mock OA backend listening on http://localhost:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
