const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const SwitcherPanel = Me.imports.panel.SwitcherPanel; 
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const { GObject, GnomeDesktop } = imports.gi;
const Gettext = imports.gettext;
const _ = Gettext.domain('monitordisplay').gettext;
const Gio = imports.gi.Gio;

let container;

function init() {
    _realHasOverview = Main.sessionMode.hasOverview;
    ExtensionUtils.initTranslations(Me.metadata['gettext-domain']);
}

function notify(msg, details, icon) {
    Main.notify(msg, details, icon);
}

function runCommand() {
    // Command to check HDMI and DisplayPort connections
    let command = "sh -c 'cat /sys/class/drm/*/status";

    let [, stdout, stderr, exitCode] = GLib.spawn_command_line_sync(command);
    if (exitCode !== 0) {
        return null;
    }

    let decoder = new TextDecoder();
    let connections = decoder.decode(stdout).trim().split('\n');

    let hdmiConnected = connections.some(line => line.includes('connected') && line.includes('HDMI'));
    let dpConnected = connections.some(line => line.includes('connected') && line.includes('DP'));

    return hdmiConnected || dpConnected;
}

function changeDisplay(id) {
    let resultadoHdmi = runCommand();
    if (!resultadoHdmi) {
        resultadoHdmi = "null";
    }
    let conectado = "connected";
    if (resultadoHdmi.trim() === conectado) {
        // Verifica se a tela está bloqueada
        if (!Main.screenShield.locked) {
            Meta.MonitorManager.get().switch_config(id);
            global.panel.hideOnClick();
        } else {
            log("Tela está bloqueada");
        }
    } else {
        global.panel.fadeAndOut();
        log("HDMI não conectado");
        notify(_("HDMI not connected."), _("You must have HDMI connected."), 'dialog-information');
    }
}

function modoAtual() {
    const monitorManager = Meta.MonitorManager.get();
    const switchConfig = monitorManager.get_switch_config();
    log("Configuração de comutação atual: " + switchConfig);
    return switchConfig;
}

class FileMonitor {
    constructor() {
        this.fileMonitor = null;
    }

    monitorFile(filePath) {
        let file = Gio.File.new_for_path(filePath);
        this.fileMonitor = file.monitor(Gio.FileMonitorFlags.NONE, null);

        this.fileMonitor.connect('changed', (fileMonitor, file, otherFile, eventType) => {
            switch (eventType) {
                case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
                    log("File changed.");
                    this.onFileChanged(file.get_path());
                    break;
                // Adicionar outros eventos conforme necessário
            }
        });
    }

    onFileChanged(filePath) {
        log("O arquivo foi alterado.");
        if (!Main.screenShield.locked) {
            global.panel.displaySwitch();
        } else {
            log("Tela está bloqueada");
        }
        // Implementar a lógica adicional quando o arquivo é alterado
    }
}

// Exemplo de uso:
let fileMonitor = new FileMonitor();
fileMonitor.monitorFile("/opt/hdmi-events");

let switchTimeout = null;

function enable() {
    global.panel = new SwitcherPanel();
    global.panel.switchTimeout = switchTimeout;
    let my_settings = ExtensionUtils.getSettings("org.gnome.shell.extensions.monitor-display-switcher");

    Main.wm.addKeybinding("keybinding", my_settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
        () => {
            if (!Main.screenShield.locked) {
                global.panel.resetTimer();
                global.panel.displaySwitch();
            } else {
                log("Tela está bloqueada");
            }
        });

    Main.wm.addKeybinding("keybinding2", my_settings,
        Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
        () => {
            if (!Main.screenShield.locked) {
                global.panel.fadeAndOut();
                global.panel.clearTimeout();
            } else {
                log("Tela está bloqueada");
            }
        });
}

function disable() {
    global.panel.destroy();
    /* Main.layoutManager.removeChrome(container); */
}
