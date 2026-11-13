#!/usr/bin/env bash
# Forwarder: intercept api.trycloudflare.com:443 locally and relay it
# through the egress proxy. cloudflared ignores the proxy env vars and
# connects direct (proven by strace), and direct :443 is intercepted,
# so without this the quick-tunnel API call fails its TLS handshake.
# Proxy credentials come from the https_proxy env var at runtime
# (never written to this file).
# /etc/hosts must map api.trycloudflare.com -> 127.0.0.1 (see watchdog.sh).
set -euo pipefail
_p="${https_proxy#http://}"
_u="${_p%%@*}"
_user="${_u%%:*}"
_pass="${_u#*:}"
exec socat TCP-LISTEN:443,bind=127.0.0.1,fork,reuseaddr "PROXY:hatch-egress-proxy:api.trycloudflare.com:443,proxyport=3128,proxyauth=${_user}:${_pass}"
