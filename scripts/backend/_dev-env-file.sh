#!/usr/bin/env bash
# 开发环境变量单文件 SSoT：仓库根 .env
# Electron、AdminDash 与 Django 脚本统一读此路径。

_dev_env_file() {
  local root_dir="${1:-.}"
  echo "${root_dir}/.env"
}

_dev_env_local_file() {
  local root_dir="${1:-.}"
  echo "${root_dir}/.env.local"
}

_dev_env_files() {
  local root_dir="${1:-.}"
  local base local_file
  base="$(_dev_env_file "${root_dir}")"
  local_file="$(_dev_env_local_file "${root_dir}")"
  [[ -f "${base}" ]] && echo "${base}"
  [[ -f "${local_file}" ]] && echo "${local_file}"
}
