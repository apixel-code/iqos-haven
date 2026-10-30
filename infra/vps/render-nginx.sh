#!/bin/sh
# Prints this environment's nginx sites from nginx-site.conf and site.env (step 123):
#   ./render-nginx.sh > /etc/nginx/sites-available/iqos-<env>
# then `nginx -t`, reload, and `certbot --nginx -d <the three hostnames>`.
set -eu
cd "$(dirname "$0")"
. ./site.env
sed -e "s/__HOST_STORE__/$IH_HOST_STORE/g" -e "s/__HOST_ADMIN__/$IH_HOST_ADMIN/g" \
  -e "s/__HOST_MEDIA__/$IH_HOST_MEDIA/g" -e "s/__PORT_STORE__/$IH_PORT_STORE/g" \
  -e "s/__PORT_ADMIN__/$IH_PORT_ADMIN/g" -e "s/__PORT_MEDIA__/$IH_PORT_MEDIA/g" nginx-site.conf
