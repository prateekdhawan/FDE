// LUMINA — single-container launcher for the Render free tier (R1 topology).
//
// Render's free tier exposes exactly ONE public port ($PORT) per web service and has no private
// service and no background worker, so all three LUMINA processes run in this one container:
//   • gateway — the ONLY public process; binds 0.0.0.0:$PORT (Render routes the internet here).
//               Holds NO provider key.
//   • agent   — binds 127.0.0.1:8000, reachable ONLY over loopback by the gateway (never public,
//               since Render routes nothing but $PORT). Holds every provider key.
//   • worker  — the M7 jobs worker; polls Atlas, listens on no port.
//
// If ANY child exits we tear the others down and exit non-zero so Render restarts the whole
// service cleanly — a half-dead container is worse than a fast restart.
import { spawn } from 'node:child_process';

const PORT = process.env.PORT ?? '10000';
const AGENT = '/app/backend/agent';
const GATEWAY = '/app/backend/gateway';

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 2000).unref();
}

function start(name, cwd, entry, extraEnv) {
  const child = spawn('node', [entry], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[render-start] ${name} exited (code=${code} signal=${signal}) — restarting container`);
    shutdown(code ?? 1);
  });
  child.on('error', (err) => {
    console.error(`[render-start] ${name} failed to start: ${err.message}`);
    shutdown(1);
  });
  children.push({ name, child });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// Private agent first (pinned to loopback:8000 so Render's $PORT can never expose it).
start('agent', AGENT, 'dist/index.js', { PORT_AGENT: '8000', AGENT_BIND_HOST: '127.0.0.1' });
// Jobs worker (same image + secrets; no listening port).
start('worker', AGENT, 'dist/worker.js', {});
// Public gateway last, on $PORT, proxying to the loopback agent.
start('gateway', GATEWAY, 'dist/index.js', { PORT_GATEWAY: PORT, AGENT_URL: 'http://127.0.0.1:8000' });

console.log(`[render-start] launched agent(127.0.0.1:8000) + worker + gateway(0.0.0.0:${PORT})`);
