# Chronicler Engine

Plataforma de escrita e RPG narrativo colaborativo: você conduz a história e o Gemini atua como **Narrador**, escrevendo a prosa em um *Tome* contínuo (sem balões de chat). Tudo roda localmente, com SQLite.

> Especificação completa e decisões de implementação: [`chronicler_engine_design_document.md`](chronicler_engine_design_document.md) (a seção 11 prevalece em caso de conflito). Andamento: [`TASKS.md`](TASKS.md).

## Recursos

- **Tome Interativo** com streaming da narrativa, edição direta, re-geração a partir do prompt de origem (descartando os blocos posteriores, com aviso) e ramificação.
- **Modo Diálogo**: o Narrador pode abrir uma conversa com um NPC (persona isolada); ao encerrar, a cena é costurada em prosa.
- **HP do Narrador**: barra de contexto (tokens usados × limite) e **Compactação de Crônica** com sinopse revisável.
- **4 temas** (Medieval, Cyberpunk, Pós-apocalíptico, Contemporâneo) com fontes empacotadas localmente.
- Interface em pt-BR; seletor de modelos alimentado pela API do Gemini.

## Executando com Docker (recomendado)

```bash
docker compose up -d --build
```

Abra <http://localhost:3000>, informe a **chave da API do Gemini** na tela inicial e crie sua primeira crônica.

- A porta é publicada **apenas em `127.0.0.1`**: a interface não tem autenticação e guarda a chave da API no banco. Não exponha a porta na rede sem um proxy com autenticação.
- Os dados (SQLite, incluindo a chave) ficam em `./data` no host. Faça backup dessa pasta.
- Parar: `docker compose down` (os dados permanecem).

## Desenvolvimento local

Requer **Node.js ≥ 22**.

```bash
npm install
npm run build:client   # gera public/assets (app.js e app.css)
npm run dev            # servidor com recarga em http://127.0.0.1:3000
```

| Comando | O que faz |
| --- | --- |
| `npm test` | Suíte de testes (Vitest; Gemini mockado, UI em jsdom) |
| `npm run typecheck` / `npm run typecheck:client` | Verificação de tipos do servidor / do cliente |
| `npm run build` | Compila o servidor (`dist/`) e o cliente (`public/assets/`) |
| `npm start` | Executa o build de produção |
| `npm run fonts` | Reempacota as fontes de `@fontsource/*` em `public/fonts/` |

### Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `127.0.0.1` (`0.0.0.0` no container) | Interface de escuta |
| `DATABASE_PATH` | `./data/chronicler.db` (`/data/chronicler.db` no container) | Arquivo SQLite |
| `PUBLIC_DIR` | `./public` | Diretório do frontend estático |

A chave da API é configurada pela interface (e gravada no banco local). O arquivo `GEMINIKEY.txt`, usado apenas pelos scripts de verificação em `scripts/live-*.ts`, está no `.gitignore`.
