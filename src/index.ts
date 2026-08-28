/**
 * Boot orchestration entry (spec §4): migrations → (scheduler / channels in
 * later loops) → HTTP + WS. Keep logic out of this file — it is env wiring
 * around server.ts so `node dist/src/index.js` and `tsx watch` behave the same.
 */
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { startServer, installSignalHandlers, type RunningServer } from './server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ config });
  const server: RunningServer = await startServer({ config, logger });
  installSignalHandlers(() => server, logger);
}

main().catch((err) => {
  // Logger may not exist yet (config failure) — fall back to stderr.
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
