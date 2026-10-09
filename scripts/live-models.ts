// Script de verificação manual: lista os modelos reais da API usando GEMINIKEY.txt.
// Não imprime a chave. Uso: npx tsx scripts/live-models.ts
import fs from 'node:fs';
import { GeminiGatewayImpl } from '../src/ai/gateway.js';
import { isTextGenerationModel } from '../src/ai/models.js';

const key = fs.readFileSync('GEMINIKEY.txt', 'utf8').trim();
const all = await new GeminiGatewayImpl(key).listModels();
console.log(`generateContent: ${all.length} modelos`);
for (const m of all) {
  console.log(`${isTextGenerationModel(m) ? 'TEXTO ' : 'outro '} ${m.id}  (in:${m.inputTokenLimit ?? '?'})`);
}
