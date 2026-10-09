import { build } from 'esbuild';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Compila o frontend (Vanilla TS) e o CSS (Tailwind) para public/assets/.
// Se ainda não houver código de frontend, não faz nada.
fs.mkdirSync('public/assets', { recursive: true });

if (fs.existsSync('client/main.ts')) {
  await build({
    entryPoints: ['client/main.ts'],
    bundle: true,
    outfile: 'public/assets/app.js',
    target: 'es2022',
    minify: process.env.NODE_ENV === 'production',
    sourcemap: true,
  });
}

if (fs.existsSync('client/styles.css')) {
  const r = spawnSync(
    'npx',
    ['tailwindcss', '-i', 'client/styles.css', '-o', 'public/assets/app.css', '--minify'],
    { stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}
