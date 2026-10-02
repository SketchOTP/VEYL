#!/bin/sh
set -eu
# FPM postinst runs as root. Configure ONLY the package's own helper and launcher.
[ "$(/usr/bin/id -u)" = 0 ] || { echo 'VEYL installation requires the package manager root context.' >&2; exit 1; }
veyl_root=/opt/VEYL
[ -f "$veyl_root/sandbox-helper.sh" ] && [ ! -L "$veyl_root/sandbox-helper.sh" ] || exit 1
# Do not source a path unless its whole chain and file ownership/mode are trusted.
veyl_parent=$veyl_root
while :; do
    [ -d "$veyl_parent" ] && [ ! -L "$veyl_parent" ] || exit 1
    veyl_meta=$(/usr/bin/stat -c '%u:%a' -- "$veyl_parent")
    veyl_owner=${veyl_meta%%:*}; veyl_mode=${veyl_meta#*:}
    case "$veyl_mode" in ''|*[!0-7]*) exit 1;; esac
    [ "$veyl_owner" = 0 ] && [ $((0$veyl_mode & 022)) -eq 0 ] || exit 1
    [ "$veyl_parent" = / ] && break
    veyl_parent=${veyl_parent%/*}; [ -n "$veyl_parent" ] || veyl_parent=/
done
[ "$(/usr/bin/stat -c '%u:%g:%a' -- "$veyl_root/sandbox-helper.sh")" = 0:0:755 ] || exit 1
. "$veyl_root/sandbox-helper.sh"
veyl_regular_root_file "$veyl_root/chrome-sandbox" || { echo 'VEYL bundled helper has unsafe ownership/path.' >&2; exit 1; }
case "$(/usr/bin/stat -c '%a' -- "$veyl_root/chrome-sandbox")" in 755|4755) ;; *) exit 1;; esac
/usr/bin/chmod 4755 -- "$veyl_root/chrome-sandbox"
veyl_secure_helper "$veyl_root/chrome-sandbox" || exit 1
# No AppArmor profile or external Chromium helper is changed.
if [ -x /usr/bin/update-desktop-database ]; then /usr/bin/update-desktop-database /usr/share/applications || true; fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then /usr/bin/gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true; fi
