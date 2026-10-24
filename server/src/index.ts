import { loadConfig, loadEnvFiles } from './config.js';
import { buildServer } from './app.js';

loadEnvFiles();
const config = loadConfig();

let app: Awaited<ReturnType<typeof buildServer>>;
try {
  app = await buildServer({ config });
} catch (error) {
  console.error('[startup] failed:', (error as Error).message);
  process.exit(1);
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

if (config.appToken === 'dev-token' || config.appToken.startsWith('change-me')) {
  app.log.warn('APP_TOKEN is using a default value. Set a long random APP_TOKEN in server/.env.');
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
