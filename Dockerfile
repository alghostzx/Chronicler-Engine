# syntax=docker/dockerfile:1

# Imagem única e leve do Chronicler Engine (docs/arquitetura.md#empacotamento-docker).
# Node 22: o better-sqlite3 13 exige Node >= 22.

# --- Base com toolchain para compilar o better-sqlite3 (quando não há binário pré-compilado) ---
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

# --- Dependências de produção ---
# O better-sqlite3 13 já traz binários pré-compilados para musl (Alpine): instala-se sem scripts e
# valida-se o carregamento. Só se isso falhar é que compila do código-fonte (toolchain da base).
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && (node --input-type=module -e "import D from 'better-sqlite3'; new D(':memory:').close()" \
     || npm rebuild better-sqlite3 --build-from-source)

# --- Build do servidor (tsc) e do cliente (esbuild + Tailwind) ---
FROM base AS builder
COPY package.json package-lock.json tsconfig.json tailwind.config.js ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY client ./client
COPY scripts ./scripts
COPY public ./public
RUN npm run build

# --- Runtime enxuto: sem toolchain, sem devDependencies ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATABASE_PATH=/data/chronicler.db

COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

# su-exec + entrypoint: ajusta a posse do volume /data (bind mount criado como root pelo Docker)
# e roda o servidor como o usuário "node", sem privilégios.
RUN apk add --no-cache su-exec && mkdir -p /data && chown node:node /data
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
