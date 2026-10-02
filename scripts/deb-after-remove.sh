#!/bin/sh
set -eu
# Package-managed files are removed by dpkg; user state and login remain untouched.
if [ -x /usr/bin/update-desktop-database ]; then /usr/bin/update-desktop-database /usr/share/applications || true; fi
if [ -x /usr/bin/gtk-update-icon-cache ]; then /usr/bin/gtk-update-icon-cache -f -t /usr/share/icons/hicolor || true; fi
