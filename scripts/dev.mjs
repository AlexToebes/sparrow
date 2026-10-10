// `pnpm dev`: shared + server compile in watch mode, the server restarts on every rebuild,
// and the Vite dev server (proxying /api to the server) runs next to them. No extra dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const say = (msg) => process.stdout.write(`[dev] ${msg}\n`);

// First build, so the watchers and the server start from a consistent dist/.
for (const pkg of ['shared', 'server']) {
  const r = spawnSync('pnpm', ['--filter', `@sparrow/${pkg}`, 'run', 'build'], {
    stdio: 'inherit',
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const children = [];
const run = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code) => {
    if (!stopping) {
      say(`${cmd} ${args.join(' ')} exited (${code}); stopping`);
      stop(code ?? 1);
    }
  });
};

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('pnpm', ['--filter', '@sparrow/shared', 'run', 'dev']);
run('pnpm', ['--filter', '@sparrow/server', 'run', 'dev']);
// DATA_DIR defaults to /data, which is rarely writable outside the container.
process.env.DATA_DIR ??= './data';
if (!existsSync('data')) say('using ./data (set DATA_DIR to change)');
run('node', ['--watch', '--watch-preserve-output', 'packages/server/dist/main.js']);
run('pnpm', ['--filter', '@sparrow/web', 'run', 'dev']);
