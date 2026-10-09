#!/bin/sh
# Garante que o volume /data (montado do host, geralmente criado como root pelo Docker)
# seja gravável pelo usuário sem privilégios, e então abandona o root.
set -e
mkdir -p "$(dirname "${DATABASE_PATH:-/data/chronicler.db}")"
chown -R node:node "$(dirname "${DATABASE_PATH:-/data/chronicler.db}")"
exec su-exec node "$@"
