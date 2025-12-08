#!/usr/bin/env python3
"""
Detect current display mode for GNOME Shell Display Switcher extension.
Outputs: internal, external, join, mirror, or unknown
"""
import sys
import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib


def get_current_display_mode():
    """Detect the current display configuration mode."""
    try:
        proxy = Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SESSION,
            Gio.DBusProxyFlags.NONE,
            None,
            "org.gnome.Mutter.DisplayConfig",
            "/org/gnome/Mutter/DisplayConfig",
            "org.gnome.Mutter.DisplayConfig",
            None,
        )

        result = proxy.call_sync(
            "GetCurrentState", None, Gio.DBusCallFlags.NONE, -1, None
        )

        if not result:
            return "unknown"

        serial, monitors, logical_monitors, properties = result.unpack()

        if not logical_monitors or len(logical_monitors) == 0:
            return "unknown"

        builtin_connector = None
        external_connector = None

        for monitor in monitors:
            monitor_spec, modes, props = monitor
            connector = monitor_spec[0]
            is_builtin = props.get("is-builtin", False)

            if is_builtin or "eDP" in connector:
                builtin_connector = connector
            elif any(x in connector for x in ["HDMI", "DP", "DVI", "USB"]):
                external_connector = connector

        active_builtin = False
        active_external = False

        for logical_monitor in logical_monitors:
            x = logical_monitor[0]
            y = logical_monitor[1]
            monitors_in_logical = (
                logical_monitor[5] if len(logical_monitor) > 5 else logical_monitor[-1]
            )

            for monitor_in_logical in monitors_in_logical:
                connector = monitor_in_logical[0]

                if connector == builtin_connector:
                    active_builtin = True
                elif connector == external_connector:
                    active_external = True

        same_position = False
        if len(logical_monitors) == 1 and active_builtin and active_external:
            same_position = True
        elif len(logical_monitors) > 1:
            positions = [f"{lm[0]},{lm[1]}" for lm in logical_monitors]
            same_position = len(positions) != len(set(positions))

        if same_position and active_builtin and active_external:
            return "mirror"
        elif active_builtin and active_external:
            return "join"
        elif active_builtin and not active_external:
            return "internal"
        elif not active_builtin and active_external:
            return "external"

        return "unknown"

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return "unknown"


if __name__ == "__main__":
    mode = get_current_display_mode()
    print(mode)
    sys.exit(0)
