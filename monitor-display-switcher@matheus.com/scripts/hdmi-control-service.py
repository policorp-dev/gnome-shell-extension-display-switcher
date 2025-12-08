#!/usr/bin/env python3
"""

Uso:
  ./hdmi-control-service.py          # monitora continuamente
  ./hdmi-control-service.py --now   # verifica apenas uma vez e sai
  ./hdmi-control-service.py --debug  # ativa debug (imprime estruturas)
"""

import gi
import sys
import os
import json
import datetime
import argparse
from typing import Optional, Any

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib

DBUS_INTERFACE = "org.gnome.Mutter.DisplayConfig"
DBUS_PATH = "/org/gnome/Mutter/DisplayConfig"

STATE_FILE = os.path.expanduser("~/.config/hdmi-control/state.json")
LOG_DIR = os.path.expanduser("~/.local/share/hdmi-control")
LOG_FILE = os.path.join(LOG_DIR, "log.txt")

os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)


def now_ts() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def log(msg: str):
    line = f"[{now_ts()}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


class SimpleSettings:
    def __init__(self, path: str = STATE_FILE):
        self.path = path
        # garante arquivo inicial
        if not os.path.exists(self.path):
            self._write({
                "external-monitor-connected": False,
                "connector": None,
                "last_checked": now_ts()
            })

    def _read(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {
                "external-monitor-connected": False,
                "connector": None,
                "last_checked": now_ts()
            }

    def _write(self, data: dict):
        try:
            with open(self.path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            log(f"Falha ao gravar estado em {self.path}: {e}")

    def get_state(self) -> dict:
        return self._read()

    def set_state(self, connected: bool, connector: Optional[str]):
        data = {
            "external-monitor-connected": bool(connected),
            "connector": connector if connector is not None else None,
            "last_checked": now_ts()
        }
        self._write(data)


class DisplayMonitorService:
    def __init__(self, debug: bool = False):
        self.debug = debug
        self.settings = SimpleSettings()
        self.proxy: Optional[Gio.DBusProxy] = None
        self.subscription_id = 0

        try:
            self.proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                None,
                DBUS_INTERFACE,
                DBUS_PATH,
                DBUS_INTERFACE,
                None
            )
            log("Conectado ao D-Bus do Mutter.")
        except Exception as e:
            log(f"ERRO: falha ao conectar ao D-Bus: {e}")
            sys.exit(1)

    def _call_getcurrentstate(self) -> Optional[Any]:
        try:
            res = self.proxy.call_sync("GetCurrentState", None, Gio.DBusCallFlags.NONE, -1, None)
            return res.unpack()
        except Exception as e:
            log(f"Erro chamando GetCurrentState: {e}")
            return None

    def _walk_and_collect_strings(self, obj, out: list):
        if isinstance(obj, (list, tuple)):
            for el in obj:
                self._walk_and_collect_strings(el, out)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                self._walk_and_collect_strings(k, out)
                self._walk_and_collect_strings(v, out)
        else:
            try:
                if isinstance(obj, bytes):
                    out.append(obj.decode(errors="ignore"))
                elif isinstance(obj, str):
                    out.append(obj)
                else:
                    # outros tipos (int/float/None) ignorados
                    pass
            except Exception:
                pass

    def _extract_connector_name(self, monitor_info) -> Optional[str]:
        collected = []
        self._walk_and_collect_strings(monitor_info, collected)

        if self.debug:
            log(f"[DEBUG] Strings coletadas do monitor: {collected}")

        for s in collected:
            if not isinstance(s, str) or not s:
                continue
            up = s.upper().strip()
            # ignorar eDP (internal) — e.g. 'eDP-1'
            if up.startswith("EDP"):
                continue
            # critérios de correspondência
            if ("HDMI" in up) or ("DP" in up) or ("DISPLAYPORT" in up) or ("DISPLAY-PORT" in up) or ("TYPEC" in up) or ("USB-C" in up) or ("USB" in up):
                # retorna o texto original (preserva capitalização)
                return s
        return None

    def _analyze_state(self) -> (bool, Optional[str]):
        tup = self._call_getcurrentstate()
        if not tup:
            return False, None

        # estrutura esperada: (serial, monitors, outputs, something)
        try:
            # unpack se possível (evita exceção quando estrutura diferente)
            if isinstance(tup, tuple) and len(tup) >= 2:
                monitors = tup[1]
            else:
                # fallback: tentar usar o segundo elemento
                monitors = tup
        except Exception:
            monitors = tup

        if self.debug:
            log(f"[DEBUG] Monitors raw: {repr(monitors)}")

        external_found = False
        connector_name = None

        # Monitors pode ser uma lista de tuplas/arrays
        try:
            for monitor_info in monitors:
                candidate = self._extract_connector_name(monitor_info)
                if candidate:
                    external_found = True
                    connector_name = candidate
                    break
        except Exception as e:
            if self.debug:
                log(f"[DEBUG] Erro ao iterar monitors: {e}")

        return external_found, connector_name

    def _check_and_update_state(self, initial: bool = False):
        connected, connector = self._analyze_state()

        prev = self.settings.get_state()
        prev_connected = bool(prev.get("external-monitor-connected", False))
        prev_connector = prev.get("connector")

        # grava se mudou ou sempre grava quando initial=True (útil para --once)
        should_write = (connected != prev_connected) or (connector != prev_connector) or initial

        if should_write:
            self.settings.set_state(connected, connector)
            if connected:
                log(f"Monitor externo conectado: {connector}")
                print("True")
                return True
            else:
                log("Monitor externo desconectado.")
                print("False")
                return False
        else:
            log(f"Sem mudança — conectado={connected}, connector={connector}")
            print("False")
            return False

    def _on_gsignal(self, proxy, sender, signal_name, params):
        if signal_name == "MonitorsChanged":
            log("Sinal 'MonitorsChanged' recebido — verificando...")
            self._check_and_update_state(initial=False)

    def start_monitoring(self):
        # verifica inicialmente (grava JSON)
        self._check_and_update_state(initial=True)
        # conecta sinal
        self.subscription_id = self.proxy.connect("g-signal", self._on_gsignal)
        log("Monitoramento iniciado. Pressione Ctrl+C para encerrar.")
        loop = GLib.MainLoop()
        try:
            loop.run()
        except KeyboardInterrupt:
            log("Encerrando serviço...")
            loop.quit()

    def check_once(self):
        self._check_and_update_state(initial=True)


def parse_args():
    p = argparse.ArgumentParser(description="HDMI/DP monitor via Mutter D-Bus")
    p.add_argument("--now", action="store_true", help="Verifica somente uma vez e sai")
    p.add_argument("--debug", action="store_true", help="Ativa debug (imprime estruturas brutas)")
    return p.parse_args()


def main():
    args = parse_args()
    service = DisplayMonitorService(debug=args.debug)

    if args.now:
        service.check_once()
        sys.exit(0)
    else:
        service.start_monitoring()


if __name__ == "__main__":
    main()

