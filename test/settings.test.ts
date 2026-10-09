import { beforeEach, describe, expect, it } from 'vitest';
import { isTextGenerationModel, pickEffectiveModel } from '../src/ai/models.js';
import { FAKE_KEY, makeApp, mockGateway, SAMPLE_MODELS, type TestApp } from './helpers.js';

let t: TestApp;

beforeEach(async () => {
  t = await makeApp();
});

describe('settings', () => {
  it('informa que não há chave e o modelo padrão', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json()).toMatchObject({ api_key_configured: false, default_model: 'gemini-3.8-flash' });
    expect(res.json().default_system_rules).toEqual(expect.any(String));
    expect(res.json().default_system_rules.length).toBeGreaterThan(50);
  });

  it('valida e grava a chave sem nunca devolvê-la', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/settings/key', payload: { api_key: FAKE_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(FAKE_KEY);
    const settings = await t.app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.json().api_key_configured).toBe(true);
    expect(settings.body).not.toContain(FAKE_KEY);
  });

  it('rejeita chave que falha na validação e não a grava', async () => {
    const bad = await makeApp(
      mockGateway({
        listModels: async () => {
          throw new Error('API key not valid');
        },
      }),
    );
    const res = await bad.app.inject({ method: 'POST', url: '/api/settings/key', payload: { api_key: FAKE_KEY } });
    expect(res.statusCode).toBe(400);
    expect(bad.repos.settings.get('gemini_api_key')).toBeUndefined();
  });

  it('remove a chave', async () => {
    await t.app.inject({ method: 'POST', url: '/api/settings/key', payload: { api_key: FAKE_KEY } });
    await t.app.inject({ method: 'DELETE', url: '/api/settings/key' });
    const settings = await t.app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.json().api_key_configured).toBe(false);
  });

  it('altera o modelo padrão', async () => {
    await t.app.inject({ method: 'PUT', url: '/api/settings/model', payload: { default_model: 'gemini-2.5-pro' } });
    const settings = await t.app.inject({ method: 'GET', url: '/api/settings' });
    expect(settings.json().default_model).toBe('gemini-2.5-pro');
  });
});

describe('modelos', () => {
  it('sem chave devolve lista vazia e available=false', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/models' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ models: [], available: false, default_model: 'gemini-3.8-flash' });
  });

  it('lista só modelos de texto e aplica fallback para o primeiro Flash', async () => {
    await t.app.inject({ method: 'POST', url: '/api/settings/key', payload: { api_key: FAKE_KEY } });
    const res = await t.app.inject({ method: 'GET', url: '/api/models' });
    const body = res.json();
    expect(body.models.map((m: { id: string }) => m.id)).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
    ]);
    expect(body.available).toBe(true);
    expect(body.default_model).toBe('gemini-3.8-flash');
    expect(body.effective_default_model).toBe('gemini-2.5-flash');
  });

  it('mantém o padrão configurado quando ele está disponível', async () => {
    await t.app.inject({ method: 'POST', url: '/api/settings/key', payload: { api_key: FAKE_KEY } });
    await t.app.inject({ method: 'PUT', url: '/api/settings/model', payload: { default_model: 'gemini-2.5-pro' } });
    const res = await t.app.inject({ method: 'GET', url: '/api/models' });
    expect(res.json().effective_default_model).toBe('gemini-2.5-pro');
  });
});

describe('pickEffectiveModel', () => {
  it('prefere Flash não-lite e cai para o primeiro disponível', () => {
    expect(pickEffectiveModel('x', SAMPLE_MODELS)).toBe('gemini-2.5-flash');
    expect(pickEffectiveModel('x', [{ id: 'a', displayName: 'a' }])).toBe('a');
    expect(pickEffectiveModel('x', [])).toBe('x');
  });
});

describe('isTextGenerationModel', () => {
  const is = (id: string) => isTextGenerationModel({ id, displayName: id });

  it('aceita modelos de texto e rejeita imagem, áudio, música, agentes e afins', () => {
    for (const id of ['gemini-3.8-flash', 'gemini-2.5-pro', 'gemini-flash-latest', 'gemma-4-31b-it']) {
      expect(is(id), id).toBe(true);
    }
    for (const id of [
      'gemini-2.5-flash-image',
      'gemini-3.8-flash-tts',
      'lyria-3.5',
      'gemini-3.5-transcribe',
      'gemini-omni-1.1-flash',
      'deep-research-preview-04-2026',
      'antigravity-preview-latest',
      'nano-banana-pro-preview',
      'gemini-robotics-er-2-preview',
    ]) {
      expect(is(id), id).toBe(false);
    }
  });
});

