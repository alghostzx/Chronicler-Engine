import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { createRepositories } from '../src/db/index.js';
import { buildApp } from '../src/server.js';
import { mockGateway } from './helpers.js';

const PUBLIC = join(process.cwd(), 'public');

let t: { app: Awaited<ReturnType<typeof buildApp>> };
beforeEach(async () => {
  const gateway = mockGateway();
  const app = await buildApp(loadConfig({ PUBLIC_DIR: PUBLIC }), {
    repos: createRepositories(openDatabase(':memory:')),
    gatewayFactory: () => gateway,
  });
  t = { app };
});

describe('frontend estático', () => {
  it('serve o index.html em pt-BR na raiz', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('lang="pt-BR"');
    expect(res.body).toContain('id="app"');
  });

  it('serve as fontes locais e não referencia CDNs', async () => {
    const css = await t.app.inject({ method: 'GET', url: '/fonts/fonts.css' });
    expect(css.statusCode).toBe(200);
    expect(css.body).not.toMatch(/https?:\/\//);
    const woff = readdirSync(join(PUBLIC, 'fonts')).find((f) => f.endsWith('.woff2'))!;
    const font = await t.app.inject({ method: 'GET', url: `/fonts/${woff}` });
    expect(font.statusCode).toBe(200);
  });

  it('index.html não carrega nada de origens externas', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//);
  });

  it('rotas /api inexistentes seguem devolvendo JSON de erro', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/nao-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
