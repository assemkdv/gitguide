import dotenv from 'dotenv';
import path from 'path';

// Local development reads the repository-root .env; on Render, variables come from the
// service's environment and this file doesn't exist (dotenv then does nothing).
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { configWarnings, getConfig } from './lib/config';

let config;
try {
  config = getConfig();
} catch (err) {
  console.error(JSON.stringify({ level: 'fatal', msg: 'invalid_configuration', detail: (err as Error).message }));
  process.exit(1);
}
for (const warning of configWarnings(config)) {
  console.warn(JSON.stringify({ level: 'warn', msg: 'config_warning', detail: warning }));
}

// Imported after configuration is validated: server.ts reads config at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { app, markShuttingDown } = require('./server') as typeof import('./server');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultIndexer } = require('./lib/indexer') as typeof import('./lib/indexer');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { checkConfiguredModels } = require('./lib/ai-models') as typeof import('./lib/ai-models');

const server = app.listen(config.port, () => {
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'listening',
      port: config.port,
      production: config.isProduction,
      retrieval: config.enableLocalEmbeddings ? 'hybrid' : 'lexical',
      trustProxyHops: config.trustProxyHops,
    }),
  );
  void checkConfiguredModels().then((check) => {
    const level = check.status === 'missing' ? 'error' : check.status === 'unknown' ? 'warn' : 'info';
    console[level === 'info' ? 'log' : level](JSON.stringify({ level, msg: 'model_check', models: config.models, ...check }));
  });
});

// Render sends SIGTERM on deploy/restart. Stop accepting work, cancel indexing, and give
// in-flight responses a short grace period before exiting.
const SHUTDOWN_GRACE_MS = 10_000;
let stopping = false;
function shutdown(signalName: string): void {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ level: 'info', msg: 'shutdown', signal: signalName }));
  markShuttingDown();
  defaultIndexer.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
