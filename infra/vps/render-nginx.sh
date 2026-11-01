#!/bin/sh
# Prints this environment's nginx sites from nginx-site.conf and site.env (step 123):
#   ./render-nginx.sh > /etc/nginx/sites-available/iqos-<env>
# then `nginx -t`, reload, and `certbot --nginx -d <the hostnames, aliases included>`.
set -eu
cd "$(dirname "$0")"
. ./site.env
sed -e "s/__HOST_STORE__/$IH_HOST_STORE/g" -e "s/__HOST_ADMIN__/$IH_HOST_ADMIN/g" \
  -e "s/__HOST_MEDIA__/$IH_HOST_MEDIA/g" -e "s/__PORT_STORE__/$IH_PORT_STORE/g" \
  -e "s/__PORT_ADMIN__/$IH_PORT_ADMIN/g" -e "s/__PORT_MEDIA__/$IH_PORT_MEDIA/g" nginx-site.conf
# Optional alias hosts (production: www) answer with a permanent redirect to the storefront.
for host in ${IH_HOST_REDIRECT:-}; do
  printf '\n# %s → https://%s (alias)\nserver {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n    return 301 https://%s$request_uri;\n}\n' \
    "$host" "$IH_HOST_STORE" "$host" "$IH_HOST_STORE"
done
