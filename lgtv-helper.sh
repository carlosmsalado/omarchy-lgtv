#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TV_CONTROL="$SCRIPT_DIR/bin/control.mjs"
HYPRMON_APPLY="$HOME/.config/hyprmoncfg/apply-profile.sh"
LAST_PROFILE_FILE="$HOME/.config/hyprmoncfg/last-profile"
PREV_SINK_FILE="$HOME/.cache/carlosmsalado-lgtv-prev-sink"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/opencode}"
LOCK_FILE="$RUNTIME_DIR/carlosmsalado-lgtv.lock"
PROBE_CACHE="$RUNTIME_DIR/carlosmsalado-lgtv-probe.json"
APPS_CACHE="$RUNTIME_DIR/carlosmsalado-lgtv-apps.json"

NODE_BIN="$(command -v node || echo /usr/bin/node)"

run_tv() {
  flock -w 8 "$LOCK_FILE" env NODE_TLS_REJECT_UNAUTHORIZED=0 NODE_NO_WARNINGS=1 "$NODE_BIN" "$TV_CONTROL" "$@"
}

get_sinks_block() {
  command -v wpctl >/dev/null 2>&1 || return 0
  wpctl status 2>/dev/null | sed -n '/^Audio/,/^Video/p' | sed -n '/Sinks:/,/Sources:/p'
}

get_lg_sink_id() {
  get_sinks_block | awk '/\[LG TV\]/ { gsub(/[^0-9]/, "", $2); if ($2 != "") { print $2; exit } }'
}

get_default_sink_info() {
  get_sinks_block | awk '
    /\*/ {
      line = $0
      sub(/^.*\*[[:space:]]*/, "", line)
      id = line
      sub(/\..*$/, "", id)
      name = line
      sub(/^[0-9]+\.[[:space:]]*/, "", name)
      sub(/[[:space:]]*\[vol:.*$/, "", name)
      print id "\t" name
      exit
    }
  '
}

file_age_sec() {
  local f="$1"
  [ -f "$f" ] || { echo 999999; return; }
  local now mtime
  now="$(date +%s)"
  mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
  echo $(( now - mtime ))
}

local_meta_json() {
  local hyprmon_available="false" active_profile=""
  if [ -x "$HYPRMON_APPLY" ] && [ -d "$HOME/.config/hyprmoncfg/profiles" ]; then
    hyprmon_available="true"
    if [ -f "$LAST_PROFILE_FILE" ]; then
      active_profile="$(tr -d '\r\n' < "$LAST_PROFILE_FILE" || true)"
    fi
  fi
  local sink_line sink_id sink_name lg_id pc_audio_on_tv="false" pc_audio_available="false"
  sink_line="$(get_default_sink_info || true)"
  sink_id="${sink_line%%$'\t'*}"
  sink_name="${sink_line#*$'\t'}"
  lg_id="$(get_lg_sink_id || true)"
  if [ -n "$lg_id" ] && [ "$sink_id" = "$lg_id" ]; then
    pc_audio_on_tv="true"
  fi
  if [ -n "$lg_id" ]; then
    pc_audio_available="true"
  fi
  jq -cn \
    --argjson hyprmonAvailable "$hyprmon_available" \
    --arg activeProfile "$active_profile" \
    --argjson pcAudioOnTv "$pc_audio_on_tv" \
    --argjson pcAudioAvailable "$pc_audio_available" \
    --arg pcAudioSinkName "$sink_name" \
    '{hyprmonAvailable: $hyprmonAvailable, activeProfile: $activeProfile, pcAudioOnTv: $pcAudioOnTv, pcAudioAvailable: $pcAudioAvailable, pcAudioSinkName: $pcAudioSinkName}'
}

toggle_pc_audio() {
  local lg_id cur_line cur_id prev_id fallback_id
  lg_id="$(get_lg_sink_id || true)"
  if [ -z "$lg_id" ]; then
    echo "LG TV PipeWire sink not found" >&2
    exit 1
  fi

  cur_line="$(get_default_sink_info || true)"
  cur_id="${cur_line%%$'\t'*}"

  if [ "$cur_id" = "$lg_id" ]; then
    prev_id=""
    if [ -f "$PREV_SINK_FILE" ]; then
      prev_id="$(tr -dc '0-9' < "$PREV_SINK_FILE" || true)"
    fi
    if [ -n "$prev_id" ] && get_sinks_block | grep -Eq "[[:space:]]${prev_id}\.[[:space:]]"; then
      wpctl set-default "$prev_id"
      exit 0
    fi
    fallback_id="$(get_sinks_block | awk -v lg="$lg_id" '/[0-9]+\./ && !/\[LG TV\]/ {
      line = $0
      sub(/^[^0-9]*/, "", line)
      sub(/\..*$/, "", line)
      if (line != "" && line != lg) { print line; exit }
    }')"
    if [ -n "$fallback_id" ]; then
      wpctl set-default "$fallback_id"
      exit 0
    fi
    echo "No alternative PipeWire sink found" >&2
    exit 1
  else
    if [ -n "$cur_id" ]; then
      mkdir -p "$(dirname "$PREV_SINK_FILE")"
      printf '%s\n' "$cur_id" > "$PREV_SINK_FILE"
    fi
    wpctl set-default "$lg_id"
  fi
}

cmd="${1:-}"
shift || true

case "$cmd" in
  probe)
    # Pure TLS reachability check (NO SSAP registration, ZERO prompts on TV).
    if [ "$(file_age_sec "$PROBE_CACHE")" -lt 10 ]; then
      cat "$PROBE_CACHE"
      exit 0
    fi
    probe_json="$(run_tv probe 2>/dev/null || printf '{"configured":false,"reachable":false,"pinMismatch":false}')"
    meta_json="$(local_meta_json)"
    out="$(jq -cn --argjson p "$probe_json" --argjson m "$meta_json" '$p + $m')"
    printf '%s\n' "$out" > "$PROBE_CACHE.tmp.$$" && mv -f "$PROBE_CACHE.tmp.$$" "$PROBE_CACHE"
    printf '%s\n' "$out"
    ;;
  state)
    tv_json="$(run_tv state 2>/dev/null || printf '{"configured":false,"online":false,"reachable":false,"pinMismatch":false,"pairingRequired":false,"powerState":"Standby","screenOff":false,"volume":0,"muted":false,"soundOutput":"","foregroundAppId":"","inputs":[],"pcInputId":""}')"
    meta_json="$(local_meta_json)"
    jq -cn --argjson tv "$tv_json" --argjson m "$meta_json" '$tv + $m'
    ;;
  apps)
    force="${1:-}"
    if [ "$force" != "--force" ] && [ "$(file_age_sec "$APPS_CACHE")" -lt 600 ]; then
      cat "$APPS_CACHE"
      exit 0
    fi
    out="$(run_tv apps)"
    printf '%s\n' "$out" > "$APPS_CACHE.tmp.$$" && mv -f "$APPS_CACHE.tmp.$$" "$APPS_CACHE"
    printf '%s\n' "$out"
    ;;
  tv)
    rm -f "$PROBE_CACHE"
    run_tv "$@"
    ;;
  profile)
    rm -f "$PROBE_CACHE"
    prof="${1:-}"
    if [[ ! "$prof" =~ ^[A-Za-z0-9._\ -]+$ ]]; then
      echo "Invalid profile name" >&2
      exit 1
    fi
    exec "$HYPRMON_APPLY" "$prof"
    ;;
  pc-audio-toggle)
    rm -f "$PROBE_CACHE"
    toggle_pc_audio
    ;;
  *)
    echo "Usage: lgtv-helper.sh {probe|state|apps|tv <args...>|profile <name>|pc-audio-toggle}" >&2
    exit 1
    ;;
esac
