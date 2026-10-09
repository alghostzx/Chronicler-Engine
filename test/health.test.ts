import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('servidor', () => {
  it('responde ao health check', async () => {
    const app = await buildApp(loadConfig({ PUBLIC_DIR: '/inexistente' }));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
