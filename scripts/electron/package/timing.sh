#!/usr/bin/env bash

pack_time_now() {
  date +%s
}

pack_time_format() {
  local seconds="${1:-0}"
  if ((seconds >= 3600)); then
    printf '%dh %dm %ds' $((seconds / 3600)) $(((seconds % 3600) / 60)) $((seconds % 60))
  elif ((seconds >= 60)); then
    printf '%dm %ds' $((seconds / 60)) $((seconds % 60))
  else
    printf '%ds' "${seconds}"
  fi
}

pack_time_begin() {
  PACK_TIME_TITLE="${1:-打包}"
  PACK_TIME_STARTED_AT="$(pack_time_now)"
  PACK_TIME_STEPS=()
}

pack_time_reset_root() {
  PACK_TIME_STARTED_AT="$(pack_time_now)"
  PACK_TIME_STEPS=()
}

pack_time_step_begin() {
  PACK_TIME_CURRENT_STEP="${1:-步骤}"
  PACK_TIME_STEP_STARTED_AT="$(pack_time_now)"
}

pack_time_step_end() {
  local name="${1:-${PACK_TIME_CURRENT_STEP:-步骤}}"
  local ended elapsed
  ended="$(pack_time_now)"
  elapsed=$((ended - ${PACK_TIME_STEP_STARTED_AT:-$ended}))
  PACK_TIME_STEPS+=("${name}|${elapsed}")
  printf '⏱  %s: %s\n' "${name}" "$(pack_time_format "${elapsed}")"
}

pack_time_step() {
  local name="$1"
  shift
  pack_time_step_begin "${name}"
  "$@"
  local status=$?
  pack_time_step_end "${name}"
  return "${status}"
}

pack_time_steps_markdown() {
  local entry name elapsed
  for entry in "${PACK_TIME_STEPS[@]:-}"; do
    name="${entry%%|*}"
    elapsed="${entry##*|}"
    printf -- '- %s：%s\n' "${name}" "$(pack_time_format "${elapsed}")"
  done
}

pack_time_summary() {
  local ended elapsed
  ended="$(pack_time_now)"
  elapsed=$((ended - ${PACK_TIME_STARTED_AT:-$ended}))
  printf '⏱  %s总耗时: %s\n' "${PACK_TIME_TITLE:-打包}" "$(pack_time_format "${elapsed}")"
}
