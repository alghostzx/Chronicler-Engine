# AGENTS.md — Guia rápido para agentes de IA

Bem-vindo ao **Chronicler Engine**. Se você é um agente de IA iniciando uma sessão sem contexto prévio, leia na ordem:

1. **[`TASKS.md`](TASKS.md)** — estado atual do projeto, histórico de fases, regras de trabalho acordadas com o autor e armadilhas conhecidas.
2. **[`docs/desenvolvimento.md`](docs/desenvolvimento.md)** — comandos, estrutura de testes, receitas práticas (como adicionar uma rota, como criar uma migração de schema, como testar) e pipeline de CI.
3. **[`docs/decisoes.md`](docs/decisoes.md)** — decisões arquiteturais e os **15 invariantes** que nunca podem ser quebrados (e os testes que os protegem).
4. **[`docs/arquitetura.md`](docs/arquitetura.md)** — visão geral da stack, mapa completo de arquivos e diretórios, concorrência (`TurnRunner`) e ciclo de geração SSE.

## Regras essenciais

- **Idioma:** responda ao autor sempre em **português (pt-BR)**, de forma direta e concisa.
- **Fluxo Git:**
  - **Features novas:** desenvolva em ramo `feature/...`, faça commits parciais e integre em `main` com `git merge --no-ff`.
  - **Bugfixes e pequenos patches (ex.: ajustes pontuais ou documentação):** commits diretos em `main` são permitidos.
  - **`git push`:** só execute mediante autorização explícita do autor.
- **Documentação viva:** cada mudança de comportamento ou rota deve atualizar o respectivo documento em [`docs/`](docs) (e [`TASKS.md`](TASKS.md) se alterar o estado do projeto).
- **Portão de qualidade obrigatório antes de concluir qualquer entrega:**
  ```bash
  npm run typecheck:all   # tsc no servidor, cliente, testes e scripts
  npm test                # suíte Vitest completa (inclui check:docs)
  npm run build           # build de produção (dist/ + public/assets/)
  npm run check:docs      # valida links, âncoras e sincronia de rotas em docs/api.md
  ```
