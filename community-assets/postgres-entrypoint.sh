#!/bin/sh
set -eu

secret_root=/run/tabtin-community-secrets
secret_file="${secret_root}/PG_INIT_PASSWORD"
mkdir -p "${secret_root}"
chmod 0755 "${secret_root}"

if [ ! -f "${secret_file}" ]; then
  temporary="${secret_file}.tmp.$$"
  umask 027
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "${temporary}"
  chmod 0440 "${temporary}"
  chown postgres:postgres "${temporary}"
  mv "${temporary}" "${secret_file}"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
