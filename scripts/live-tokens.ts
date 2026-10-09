// Verificação manual: countTokens real. Uso: npx tsx scripts/live-tokens.ts
import fs from 'node:fs';
import { GeminiGatewayImpl } from '../src/ai/gateway.js';
import { DEFAULT_SYSTEM_RULES } from '../src/prompts/narrator.js';

const gw = new GeminiGatewayImpl(fs.readFileSync('GEMINIKEY.txt', 'utf8').trim());
const model = 'gemini-3.8-flash';
const text = 'A madeira carcomida da porta rangeu sob sua mão. '.repeat(40);

const regras = await gw.countTokens({ model, userText: 'oi' });
const comSistema = await gw.countTokens({ model, systemInstruction: DEFAULT_SYSTEM_RULES, userText: 'oi' });
const longo = await gw.countTokens({ model, systemInstruction: DEFAULT_SYSTEM_RULES, userText: text });
console.log({ soUsuario: regras, comRegrasDeSistema: comSistema, textoLongo: longo, chars: text.length });
console.log(comSistema > regras ? 'OK: systemInstruction entra na contagem' : 'ATENÇÃO: systemInstruction ignorada');
