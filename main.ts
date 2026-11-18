// main.ts — entrypoint: start the forge, register with the trial env, wait for done.
//
// Lifecycle (kit RULES.txt):
//   1. Bind an ephemeral port (port 0; never 8080 — the env owns it).
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}, then exit 0.
// Only Node built-ins are used: no packages, no model calls.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL;

if (!ENV_URL) {
  console.error('main: MAKEFUN_ENV_URL is not set');
  process.exit(1);
}

// Drop any trailing slashes so the endpoint URLs join predictably.
const envOrigin = ENV_URL.replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// POST {"port": n} to the env's register endpoint. A 2xx answer or a 409
// (another entry already registered) both mean we can move on to polling.
// Anything else is retried with exponential backoff until it lands.
async function register(port: number): Promise<void> {
  let delayMs = 200;
  for (;;) {
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok || res.status === 409) return;
      console.error(`main: register answered ${res.status}, retrying`);
    } catch (err) {
      console.error(`main: register failed (${errorMessage(err)}), retrying`);
    }
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
}

// GET /done until the env answers {"done": true}. A reachable env that says
// not done is polled again after ~200ms; a failed or odd poll backs off
// (up to 5s) and retries. This never exits on its own.
async function waitForDone(): Promise<void> {
  let delayMs = 200;
  for (;;) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        delayMs = 200;
      } else {
        console.error(`main: done poll answered ${res.status}, backing off`);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    } catch (err) {
      console.error(`main: done poll failed (${errorMessage(err)}), backing off`);
      delayMs = Math.min(delayMs * 2, 5000);
    }
    await sleep(delayMs);
  }
}

async function main(): Promise<void> {
  const app = createApp();

  // Bind port 0: the kernel picks a free ephemeral port.
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    app.once('error', onError);
    app.listen(0, () => {
      app.removeListener('error', onError);
      const address = app.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('main: server has no TCP address after listen'));
        return;
      }
      resolve(address.port);
    });
  });
  console.log(`main: forge listening on port ${port}`);

  await register(port);
  await waitForDone();

  await new Promise<void>((resolve) => app.close(() => resolve()));
  process.exit(0);
}

main().catch((err) => {
  console.error(`main: fatal: ${errorMessage(err)}`);
  process.exit(1);
});
