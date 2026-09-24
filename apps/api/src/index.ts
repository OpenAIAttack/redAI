import { buildServer, getEnv } from './server.js';

async function main(): Promise<void> {
  const env = getEnv();
  const app = buildServer({ env });
  try {
    await app.listen({ host: env.host, port: env.port });
    console.log(`redAI api listening on http://${env.host}:${env.port} (env=${env.nodeEnv})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
