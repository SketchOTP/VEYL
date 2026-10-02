#!/bin/sh
# Shared by the portable launcher and package-owned Debian hook. No provisioning.
veyl_safe_parents() {
    veyl_parent=$1
    while :; do
        [ -d "$veyl_parent" ] && [ ! -L "$veyl_parent" ] || return 1
        veyl_meta=$(/usr/bin/stat -c '%u:%a' -- "$veyl_parent") || return 1
        veyl_owner=${veyl_meta%%:*}; veyl_mode=${veyl_meta#*:}
        case "$veyl_mode" in ''|*[!0-7]*) return 1;; esac
        [ "$veyl_owner" = 0 ] && [ $((0$veyl_mode & 022)) -eq 0 ] || return 1
        [ "$veyl_parent" = / ] && break
        veyl_parent=${veyl_parent%/*}; [ -n "$veyl_parent" ] || veyl_parent=/
    done
}
veyl_regular_root_file() {
    case "$1" in /*) ;; *) return 1;; esac
    [ -f "$1" ] && [ ! -L "$1" ] || return 1
    [ "$(/usr/bin/readlink -e -- "$1")" = "$1" ] || return 1
    [ "$(/usr/bin/stat -c '%u:%g' -- "$1")" = 0:0 ] || return 1
    veyl_safe_parents "${1%/*}"
}
veyl_secure_helper() {
    veyl_regular_root_file "$1" || return 1
    [ "$(/usr/bin/stat -c '%a' -- "$1")" = 4755 ]
}
