#!/bin/sh
# Garante que o volume /data (montado do host, geralmente criado como root pelo Docker)
# seja gravável pelo usuário sem privilégios, e então abandona o root.
# Se o contêiner já foi iniciado sem root (ex.: Podman rootless com --userns=keep-id --user),
# não há o que ajustar: apenas executa o comando.
set -e
if [ "$(id -u)" = "0" ]; then
  data_dir="$(dirname "${DATABASE_PATH:-/data/chronicler.db}")"
  mkdir -p "$data_dir"
  chown -R node:node "$data_dir"
  exec su-exec node "$@"
fi
exec "$@"
