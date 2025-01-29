#
# Regular cron jobs for the gnome-shell-extension-display-switcher package.
#
0 4	* * *	root	[ -x /usr/bin/gnome-shell-extension-display-switcher_maintenance ] && /usr/bin/gnome-shell-extension-display-switcher_maintenance
