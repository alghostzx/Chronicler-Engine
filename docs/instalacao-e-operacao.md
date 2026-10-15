# Instalação e operação

Como subir, atualizar, parar e fazer backup do Chronicler Engine, e o que fazer quando algo dá errado. Para começar rápido, veja o [README](../README.md#começando).

## Requisitos

| O que | Para quê |
| --- | --- |
| **Docker** com Compose v2 **ou** **Podman** (+ `podman-compose`) | Subir o contêiner (não é preciso instalar Node na máquina) |
| **Chave da API do Gemini** | Gerar texto (e voz). Crie uma no [Google AI Studio](https://aistudio.google.com/apikey); ela é informada pela interface, não por arquivo |
| ~300 MB de disco e internet no *build* | Baixar a imagem `node:22-alpine` e as dependências |

O fluxo é o mesmo em Linux, macOS ou Windows (WSL2) que rodem contêineres.

## Subindo com Docker

Pela imagem pré-compilada do GitHub Actions (não compila nada no servidor):

```bash
docker run -d --name chronicler-engine --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v ./data:/data \
  ghcr.io/alghostzx/chronicler-engine:latest
```

Ou pelo repositório, com Docker Compose:

```bash
git clone https://github.com/alghostzx/Chronicler-Engine.git chronicler-engine
cd chronicler-engine
docker compose up -d            # puxa a imagem pronta do GHCR
docker compose up -d --build    # ou compila localmente
```

Abra <http://localhost:3000>. O contêiner reinicia sozinho (`restart: unless-stopped`) e os dados ficam em `./data`.

> [!NOTE]
> Se o Docker acusar `permission denied ... docker.sock`, o seu usuário não está no grupo `docker`: rode `sudo usermod -aG docker $USER` e abra uma nova sessão (ou use `newgrp docker`). Se disser que não consegue conectar à API, o serviço está parado: `sudo systemctl enable --now docker`.

Validado com Docker 29 + Compose 5 (Fedora 44): *build*, volume criado pelo próprio Docker (o *entrypoint* acerta a posse e o servidor roda **sem root**), `healthcheck` *healthy*, dados persistindo após `restart` e parada em menos de 1 s.

## Subindo com Podman

Rootless (sem `sudo`), inclusive em Fedora/RHEL com SELinux. Há duas formas equivalentes.

**A) Com `podman-compose`** (`pip install --user podman-compose` ou `sudo dnf install podman-compose`):

```bash
git clone https://github.com/alghostzx/Chronicler-Engine.git chronicler-engine
cd chronicler-engine
mkdir -p data
podman-compose -f docker-compose.yml -f docker-compose.podman.yml up -d --build
```

**B) Só com `podman`** (sem compose):

```bash
podman build -t chronicler-engine .
mkdir -p data
podman run -d --name chronicler-engine --restart unless-stopped \
  --userns=keep-id --user "$(id -u):$(id -g)" \
  -p 127.0.0.1:3000:3000 \
  -v ./data:/data:Z \
  chronicler-engine
```

Por que o `docker-compose.podman.yml` e esses parâmetros? Em modo rootless, o "root" do contêiner é o seu usuário. Com `--userns=keep-id` + `--user`, os arquivos de `./data` continuam pertencendo a você; o sufixo `:Z` do volume ajusta o rótulo SELinux (inofensivo onde não há SELinux). O `HEALTHCHECK` do Dockerfile é ignorado no formato OCI do Podman (só aparece um aviso no *build*).

## Segurança

A interface **não tem autenticação** e o banco guarda a chave da API em texto plano. Por isso a porta é publicada somente em `127.0.0.1`. Para acessar de outra máquina, ponha um proxy reverso com autenticação (ou uma VPN) na frente: **não** troque o *bind* para `0.0.0.0` sozinho.

## Atualizar, parar e fazer backup

| Tarefa | Docker | Podman (compose) |
| --- | --- | --- |
| Atualizar após `git pull` | `docker compose up -d --build` | `podman-compose -f docker-compose.yml -f docker-compose.podman.yml up -d --build --force-recreate` |
| Ver logs | `docker compose logs -f` | `podman logs -f chronicler-engine` |
| Parar (dados ficam) | `docker compose down` | `podman-compose -f docker-compose.yml -f docker-compose.podman.yml down` |

> [!TIP]
> No Podman, `up -d --build` sozinho **reconstrói a imagem mas pode manter o contêiner antigo** em execução. Use `--force-recreate` (ou `down` antes) para garantir a versão nova e faça um *hard refresh* no navegador (`Ctrl+Shift+R`).

- **Backup:** todos os dados (SQLite + chave) estão na pasta `./data`. Pare o contêiner e copie a pasta (`cp -a data data.bak`). Para guardar só as histórias, use *Salvar em Markdown* ([Guia de uso](guia-de-uso.md#exportar-em-markdown)).
- **Recomeçar do zero:** pare o contêiner e apague `./data`.
- **Outra porta:** mude `127.0.0.1:3000:3000` no `docker-compose.yml` (por exemplo `127.0.0.1:8080:3000`).

### Atualizar e migrar o banco

O projeto está em **alpha**, mas o banco **é migrado automaticamente** ao subir (a partir do schema v3), depois de salvar uma cópia ao lado (`chronicler.db.v3.bak`, `chronicler.db.v4.bak`… com o nome da versão antiga). Se um passo falhar, nada é alterado.

- As páginas de diálogo criadas antes do schema v5 passam a ser tratadas como transcrição crua e podem ser reprocessadas com *Narrar diálogo*.
- No schema v6 a opção separada de narração automática dos diálogos deixou de existir: valores antigos dela são descartados, e as páginas de diálogo seguem a opção única de cada crônica (ou o padrão global).
- Bancos mais antigos (v1/v2, de antes das páginas e da narração por voz) **não são migráveis**: pare o contêiner, apague `./data` e suba de novo (antes, salve as crônicas que quiser guardar com *Salvar em Markdown*).
- Um banco de versão **mais nova** que a do programa também é recusado.
- Uma versão futura pode voltar a exigir apagar `./data` se migrar for inviável; o aviso vem na mensagem de erro da inicialização. A política e o histórico estão em [Modelo de dados](modelo-de-dados.md#migrações).

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `127.0.0.1` (`0.0.0.0` no contêiner) | Interface de escuta |
| `DATABASE_PATH` | `./data/chronicler.db` (`/data/chronicler.db` no contêiner) | Arquivo SQLite |
| `PUBLIC_DIR` | `./public` | Diretório do frontend estático |
| `TTS_MAX_RPM` | `10` | Chamadas por minuto à API de voz do Gemini (limite do tier; veja [Narração por voz](narracao-por-voz.md#limites-conhecidos)) |

A chave da API é configurada pela interface e gravada no banco local. O arquivo `GEMINIKEY.txt`, usado apenas pelos scripts `scripts/live-*.ts` de verificação, está no `.gitignore`.

## Solução de problemas

| Sintoma | Causa provável / solução |
| --- | --- |
| `port is already allocated` / `address already in use` | A porta 3000 está ocupada (ou um contêiner antigo ainda a segura). Use `docker ps` / `podman ps -a`, remova o antigo ou mude a porta. |
| Podman: *name already in use* ou o *pod* "quebra" por causa de outro contêiner | Remova o remanescente: `podman rm -f chronicler-engine` e suba de novo. |
| `attempt to write a readonly database` / `EACCES` em `./data` | Permissão do volume. No Podman use o `docker-compose.podman.yml` (ou `--userns=keep-id --user …`); com UID diferente de 1000, ajuste `user:` no arquivo. No Docker o *entrypoint* corrige a posse sozinho. |
| Lista de modelos vazia / "Não foi possível consultar" | Chave inválida, sem internet no contêiner ou cota esgotada. Clique em *Atualizar* depois de resolver. |
| Atualizei mas a interface não mudou | Veja a dica de `--force-recreate` acima e o *hard refresh*. |
| `permission denied` em `/var/run/docker.sock` | Usuário fora do grupo `docker`: `sudo usermod -aG docker $USER` e nova sessão de login. |
| `docker compose` não existe | Instale o plugin Compose v2 (ou use `docker-compose`), ou siga o caminho Podman (B), que não precisa de compose. |
| O banco foi recusado na abertura | Veja [Atualizar e migrar o banco](#atualizar-e-migrar-o-banco): a mensagem diz se é versão antiga demais ou mais nova que o programa. |
