#!/bin/bash
set -euo pipefail

: "${STATE_DIRECTORY:?Run coa-demo-health.service to provision its state directory}"

probe() {
  local expected=$1 status
  shift
  status=$(curl --disable --noproxy '*' --silent --max-time 4 --output /dev/null --write-out '%{http_code}' "$@") || return 1
  [[ "$status" == "$expected" || ( "$expected" == any && "$status" == [1-5][0-9][0-9] ) ]]
}

active_invocation() {
  local invocation
  systemctl is-active --quiet "$1" || return 1
  invocation=$(systemctl show --property=InvocationID --value "$1") || return 1
  [[ "$invocation" =~ ^[[:xdigit:]]{32}$ && "$invocation" != 00000000000000000000000000000000 ]] || return 1
  printf '%s\n' "$invocation"
}

save_state() {
  local path=$1
  shift
  printf '%s %s %s\n' "$@" > "$path.new"
  mv -f -- "$path.new" "$path"
}

dependencies_active() {
  case "$1" in
    caddy.service)
      systemctl is-active --quiet coa-demo.service ;;
    coa-demo-named-tunnel.service)
      systemctl is-active --quiet coa-demo.service && systemctl is-active --quiet caddy.service ;;
    *) return 0 ;;
  esac
}

check_unit() {
  local unit=$1 invocation previous=- failures=0 retry_after=0 extra now
  shift
  local path="$STATE_DIRECTORY/$unit"
  if [[ -e "$path" ]] && { ! read -r previous failures retry_after extra < "$path" ||
    [[ -n "$extra" || ! "$failures" =~ ^[0-3]$ || ! "$retry_after" =~ ^(0|[1-9][0-9]{0,11})$ ]]; }; then
    printf 'Health state is invalid for %s; recovery skipped\n' "$unit" >&2
    return
  fi

  if ! invocation=$(active_invocation "$unit") || probe "$@"; then
    if (( failures > 0 )); then
      save_state "$path" "$previous" 0 "$retry_after"
    fi
    return
  fi

  if [[ "$previous" != "$invocation" ]]; then
    failures=0
  fi
  if (( failures < 3 )); then
    failures=$((failures + 1))
  fi
  printf 'Local health probe failed for %s (%s/3)\n' "$unit" "$failures" >&2

  if (( failures == 3 )); then
    now=$(date +%s)
    if (( now >= retry_after )) && dependencies_active "$unit" &&
      [[ "$(active_invocation "$unit")" == "$invocation" ]]; then
      # Record the cooldown before submitting any restart to PID 1.
      save_state "$path" "$invocation" 0 "$((now + 900))"
      if systemctl --no-block --job-mode=fail try-restart "$unit"; then
        printf 'Requested recovery restart for %s\n' "$unit" >&2
      else
        printf 'Recovery restart was not queued for %s\n' "$unit" >&2
      fi
      return
    fi
  fi
  save_state "$path" "$invocation" "$failures" "$retry_after"
}

check_unit coa-demo.service 200 http://127.0.0.1:8766/api/source
# This path returns a proxy response with no dependency on the application.
check_unit caddy.service any --header 'Host: coa-assistent.app' --header 'X-Forwarded-Proto: https' http://127.0.0.1:9899/__coa_health
check_unit coa-demo-named-tunnel.service 200 http://127.0.0.1:20243/ready

if ! probe 200 https://coa-assistent.app/api/source; then
  printf '%s\n' 'Public HTTPS probe failed for coa-assistent.app/api/source' >&2
fi
