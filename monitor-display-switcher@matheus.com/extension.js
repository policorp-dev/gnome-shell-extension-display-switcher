import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Gettext from 'gettext';

import { HdmiToggle } from './quickSettingsToggle.js';

const REF_HIGH_RES = { width: 1920, height: 1200, marginTop: 150, iconSize: 55, fontSize: 30 };
const REF_LOW_RES  = { width: 864,  height: 486,  marginTop: 50,  iconSize: 25, fontSize: 15 };
    
class FileMonitor {
    constructor(callback) {
        this._fileMonitor = null;
        this._callback = callback;
    }

    monitorFile(filePath) {
        const file = Gio.File.new_for_path(filePath);
        
        if (!file.query_exists(null)) {
            log(`[Monitor] Arquivo não encontrado: ${filePath}`);
            return;
        }

        this._fileMonitor = file.monitor(Gio.FileMonitorFlags.NONE, null);
        this._fileMonitor.connect('changed', (monitor, file, otherFile, eventType) => {
            if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                log(`[Monitor] Alteração detectada em: ${file.get_path()}`);
                this._callback();
            }
        });
    }

    destroy() {
        if (this._fileMonitor) {
            this._fileMonitor.cancel();
            this._fileMonitor = null;
        }
    }
}

export default class DisplaySwitcher extends Extension {
    constructor(metadata) {
        super(metadata);
        this._keybindingId = 'shortcut-hdmidisplay';
        this._autoApplyTimeout = null;
        this._lastSelectedMode = null;
        this._inactivityTimeout = null; 
        this._fileMonitor = null;
        this._buttonMap = new Map();
    }

    enable() {
        this._gettextDomain = 'monitordisplay';
        Gettext.bindtextdomain(this._gettextDomain, this.path + '/locale');
        this._firstExecution = true;
        this._settings = this.getSettings();
        
        Main.wm.addKeybinding(
            this._keybindingId,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL,
            () => {
                if (this._hdmiWindow) {
                    this._cycleDisplayMode();
                } else {
                    this._checkHdmiConnection();
                }
            }
        );
        
        this._fileMonitor = new FileMonitor(() => {
            if (!Main.screenShield.locked) {
                this._checkHdmiConnection();
            } else {
                log("[Monitor] Ignorando evento - tela bloqueada");
            }
        });
        
        try {
            this._fileMonitor.monitorFile("/opt/hdmi-events");
        } catch (e) {
            log(`Erro no monitoramento: ${e.message}`);
        }

        // Add Quick Settings Toggle
        this._hdmiToggle = new HdmiToggle(this);
        this._quickSettingsIndicator = new QuickSettings.SystemIndicator();
        this._quickSettingsIndicator.quickSettingsItems.push(this._hdmiToggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quickSettingsIndicator);

        // Settings Listener
        this._settings.connect('changed::show-quick-settings-toggle', () => {
            this._checkHdmiConnection();
        });

        this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this._hdmiWindow) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    if (this._hdmiWindow) this._repositionWindow();
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        // Initial Detection
        this._detectCurrentDisplayMode();
    }

    disable() {
        if (this._interval) {
            GLib.source_remove(this._interval);
            this._interval = null;
        }
        this._removeHdmiMenu();
        this._removeHdmiWindow();
        Main.wm.removeKeybinding(this._keybindingId);
        this._settings = null;
        if (this._fileMonitor) {
            this._fileMonitor.destroy();
            this._fileMonitor = null;
        }
        this._buttonMap.clear();

        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }

        // Cleanup Quick Settings
        if (this._hdmiToggle) {
            this._hdmiToggle.destroy();
            this._hdmiToggle = null;
        }
        if (this._quickSettingsIndicator) {
            this._quickSettingsIndicator.destroy();
            this._quickSettingsIndicator = null;
        }
    }

    _runCommand() {
        return new Promise((resolve, reject) => {
            const scriptPathSwitch = this.path + '/scripts/hdmi-control-service.py';
            const stateFilePath = GLib.build_filenamev([GLib.get_user_config_dir(), 'hdmi-control', 'state.json']);

            new Promise((subResolve, subReject) => {
                try {
                    const xrandProc = new Gio.Subprocess({
                        argv: ['xrandr', '--query'],
                        flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                    });
                    xrandProc.init(null);

                    xrandProc.communicate_utf8_async(null, null, (proc, res) => {
                        try {
                            proc.communicate_utf8_finish(res);
                            log('xrandr finished, refreshing state...');
                            subResolve();
                        } catch (e) {
                            subReject(e);
                        }
                    });
                } catch (e) {
                    subReject(e);
                }
            })
            .then(() => {
                return new Promise((subResolve, subReject) => {
                    try {
                        const proc = new Gio.Subprocess({
                            argv: ['python3', scriptPathSwitch, '--now'],
                            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                        });
                        proc.init(null);
                        proc.communicate_utf8_async(null, null, (p, res) => {
                            try {
                                p.communicate_utf8_finish(res);
                                subResolve();
                            } catch (e) {
                                subReject(e);
                            }
                        });
                    } catch (e) {
                        subReject(e);
                    }
                });
            })
            .then(() => {
                log('State refresh finished, reading file...');
                const stateFile = Gio.File.new_for_path(stateFilePath);
                
                if (!stateFile.query_exists(null)) {
                    log('State file not found.');
                    resolve(false);
                    return;
                }

                stateFile.load_contents_async(null, (file, res) => {
                    try {
                        const [success, contents] = file.load_contents_finish(res);
                        if (!success) {
                            resolve(false);
                            return;
                        }
                        const jsonStr = new TextDecoder().decode(contents);
                        const data = JSON.parse(jsonStr);
                        resolve(data["external-monitor-connected"] === true);
                    } catch (e) {
                        log(`Error reading JSON: ${e.message}`);
                        resolve(false);
                    }
                });
            })
            .catch((e) => {
                log(`Error in detection chain: ${e.message}`);
                resolve(false);
            });
        });
    }

    _notify(msg, details, icon) {
        Main.notify(msg, details, icon);
    }

    _detectCurrentDisplayMode() {
        return new Promise((resolve) => {
            const scriptPath = this.path + '/scripts/detect-display-mode.py';
            
            try {
                const proc = Gio.Subprocess.new(
                    ['python3', scriptPath],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                let timeoutReached = false;
                const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                    log('[DisplayMode] Detection timeout, using fallback');
                    timeoutReached = true;
                    resolve(null);
                    return GLib.SOURCE_REMOVE;
                });

                proc.communicate_utf8_async(null, null, (proc, res) => {
                    if (timeoutReached) {
                        try {
                            const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                            if (stdout) {
                                const mode = stdout.trim();
                                if (['internal', 'external', 'join', 'mirror'].includes(mode)) {
                                    log(`[DisplayMode] Detected (late): ${mode}`);
                                    if (this._buttonMap && this._buttonMap.size > 0) {
                                        this._updateActiveIndicator(mode);
                                    }
                                }
                            }
                        } catch (e) {
                            log(`[DisplayMode] Late detection error: ${e.message}`);
                        }
                        return;
                    }
                    
                    GLib.source_remove(timeoutId);
                    
                    try {
                        const [, stdout, stderr] = proc.communicate_utf8_finish(res);
                        
                        if (stdout) {
                            const mode = stdout.trim();
                            if (['internal', 'external', 'join', 'mirror'].includes(mode)) {
                                log(`[DisplayMode] Detected: ${mode}`);
                                if (this._hdmiToggle) {
                                    this._hdmiToggle.updateState(mode);
                                }
                                resolve(mode);
                                return;
                            }
                        }
                        
                        if (stderr) {
                            log(`[DisplayMode] Error: ${stderr}`);
                        }
                        
                        resolve(null);
                    } catch (e) {
                        log(`[DisplayMode] Exception: ${e.message}`);
                        resolve(null);
                    }
                });
            } catch (e) {
                log(`[DisplayMode] Failed to spawn: ${e.message}`);
                resolve(null);
            }
        });
    }

    async _checkHdmiConnection() {
        try {
            let connect = await this._runCommand();
            const showInMenu = this._settings.get_boolean('show-quick-settings-toggle');

            if (this._hdmiToggle) {
                if (!showInMenu) {
                    this._hdmiToggle.visible = false;
                } else {
                    this._hdmiToggle.visible = true;
                    this._hdmiToggle.setActiveState(connect);
                }
            }

            if (connect) {
                this._showHdmiWindow();
            } else {
                this._removeHdmiWindow();
                log("HDMI Disconnected");
                this._notify(
                    Gettext.dgettext(this._gettextDomain, "HDMI Disconnected"),
                    Gettext.dgettext(this._gettextDomain, "The HDMI cable is not connected."),
                    "video-display-symbolic"
                );
            }
        } catch (e) {
            log(`Error checking HDMI connection: ${e.message}`);
        }
    }
        
    _showIconHdmiMenu() {
        if (this._hdmiMenu) return;
        
        this._hdmiMenu = new PanelMenu.Button(0.0, Gettext.dgettext(this._gettextDomain, "HDMI Display Mode"));
        let icon = new St.Icon({ 
            icon_name: 'video-display-symbolic', 
            style_class: 'system-status-icon' 
        });
        this._hdmiMenu.add_child(icon);

        let internalOnly = new PopupMenu.PopupMenuItem(Gettext.dgettext(this._gettextDomain, "Internal only"));
        let externalOnly = new PopupMenu.PopupMenuItem(Gettext.dgettext(this._gettextDomain, "External only"));
        let joinDisplay = new PopupMenu.PopupMenuItem(Gettext.dgettext(this._gettextDomain, "Extended"));
        let mirrorDisplay = new PopupMenu.PopupMenuItem(Gettext.dgettext(this._gettextDomain, "Mirror"));

        const connectAction = (item, mode) => {
            item.connect('activate', () => {
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                }
                this._setDisplayMode(mode);
                this._hdmiMenu.menu.close();
            });
        };

        connectAction(internalOnly, 'internal');
        connectAction(externalOnly, 'external');
        connectAction(joinDisplay, 'join');
        connectAction(mirrorDisplay, 'mirror');

        this._hdmiMenu.menu.addMenuItem(internalOnly);
        this._hdmiMenu.menu.addMenuItem(externalOnly);
        this._hdmiMenu.menu.addMenuItem(joinDisplay);
        this._hdmiMenu.menu.addMenuItem(mirrorDisplay);
 
        Main.panel.addToStatusArea("hdmiDisplayMenu", this._hdmiMenu);
    }

    _removeHdmiMenu() {
        if (this._hdmiMenu) {
            this._hdmiMenu.destroy();
            this._hdmiMenu = null;
        }
    }

    _getScaledLayout(monitorHeight) {
        const clampedHeight = Math.min(Math.max(monitorHeight, 486), 1080);
        const scale = (clampedHeight - 486) / (1080 - 486);
        
        const height = Math.round(350 + (700 - 350) * scale);
        const width = Math.round(300 + (500 - 300) * scale);
        const margin = Math.round(10 + (30 - 10) * scale);
        const iconSize = Math.round(24 + (34 - 24) * scale); // 24px -> 34px
        const fontSize = Math.round(14 + (19 - 14) * scale); // 14px -> 19px
        const paddingV = Math.round(12 + (46 - 12) * scale); // 12px -> 46px
        const paddingH = Math.round(16 + (50 - 16) * scale); // 16px -> 50px
        
        const indicatorWidth = Math.round(30 + (50 - 30) * scale);
        const iconColWidth = Math.round(50 + (80 - 50) * scale);

        return { height, width, margin, iconSize, fontSize, paddingV, paddingH, indicatorWidth, iconColWidth };
    }

    _repositionWindow() {
        if (!this._hdmiWindow) return;

        const monitor = Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        
        const layout = this._getScaledLayout(monitor.height);

        let [minW, naturalW] = this._hdmiWindow.get_preferred_width(-1);
        
        const CALCULATED_WIDTH = Math.max(layout.width, naturalW); 
        const CALCULATED_HEIGHT = layout.height;
        const MARGIN = layout.margin;

        const finalX = workArea.x + workArea.width - CALCULATED_WIDTH - MARGIN;
        const finalY = (workArea.y + workArea.height) - CALCULATED_HEIGHT - MARGIN;

        this._hdmiWindow.set_position(finalX, finalY);
        this._hdmiWindow.set_size(CALCULATED_WIDTH, CALCULATED_HEIGHT);
    }

    _showHdmiWindow() {
        if (this._hdmiWindow || !this._firstExecution) return;
  
        this._hdmiWindow = new St.BoxLayout({
            vertical: true,
            style_class: 'hdmi-flyout',
            opacity: 0
        });
        
        const monitor = Main.layoutManager.primaryMonitor;
        const layout = this._getScaledLayout(monitor.height);

        let headerBox = new St.BoxLayout({
            vertical: false,
            style_class: 'hdmi-flyout-header'
        });
        
        //let backIcon = new St.Icon({
        //    icon_name: 'go-previous-symbolic',
        //    icon_size: 16,
        //    style_class: 'hdmi-header-back-icon'
        //});
        
        let titleLabel = new St.Label({
            text: Gettext.dgettext(this._gettextDomain, "HDMI Display Mode"),
            style_class: 'hdmi-flyout-title',
            y_align: Clutter.ActorAlign.CENTER
        });
        
        let spacer = new St.Widget({ x_expand: true });
        
        let displayIcon = new St.Icon({
            icon_name: 'video-display-symbolic',
            icon_size: 16,
            style_class: 'hdmi-header-icon'
        });
        
        let keyLabel = new St.Label({
            text: 'Super + P',
            style_class: 'hdmi-header-key',
            y_align: Clutter.ActorAlign.CENTER
        });
        
        //headerBox.add_child(backIcon);
        headerBox.add_child(titleLabel);
        headerBox.add_child(spacer);
        headerBox.add_child(displayIcon);
        headerBox.add_child(keyLabel);
        
        this._hdmiWindow.add_child(headerBox);
    
        const createOptionItem = (iconName, labelText, mode) => {
            let indicator = new St.Icon({
                icon_name: 'object-select-symbolic', // Checkmark
                icon_size: 16,
                style_class: 'active-mode-checkbox',
                visible: true,
                opacity: 0
            });
            
            let indicatorContainer = new St.Bin({
                style_class: 'hdmi-indicator-container',
                child: indicator,
                style: `width: ${layout.indicatorWidth}px;`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });
            
            let icon = new St.Icon({
                icon_name: iconName,
                icon_size: layout.iconSize,
                style_class: 'hdmi-option-icon'
            });
            
            let iconContainer = new St.Bin({
                style_class: 'hdmi-icon-container',
                child: icon,
                style: `width: ${layout.iconColWidth}px;`,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER
            });
            
            let label = new St.Label({ 
                text: Gettext.dgettext(this._gettextDomain, labelText),
                style_class: 'hdmi-option-label',
                style: `font-size: ${layout.fontSize}px;`,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true
            });
            
            let contentBox = new St.BoxLayout({ 
                vertical: false,
                style_class: 'hdmi-option-content',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL
            });
            
            contentBox.add_child(indicatorContainer);
            contentBox.add_child(iconContainer);
            contentBox.add_child(label);
    
            let button = new St.Button({
                style_class: 'hdmi-option-item',
                style: `padding: ${layout.paddingV}px ${layout.paddingH}px;`,
                child: contentBox,
                reactive: true,
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL
            });

            button._indicator = indicator;
            button._mode = mode;
    
            button.connect('enter-event', () => {
                this._resetInactivityTimeout();
                this._resetActiveButton();
                button.add_style_class_name('hdmi-option-hover');
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                }
            });
            
            button.connect('leave-event', () => {
                button.remove_style_class_name('hdmi-option-hover');
            });
    
            button.connect('clicked', () => {
                if (this._autoApplyTimeout) {
                    GLib.source_remove(this._autoApplyTimeout);
                    this._autoApplyTimeout = null;
                }
                this._resetInactivityTimeout();
                this._updateActiveIndicator(mode);
                this._setDisplayMode(mode);
                this._removeHdmiWindow();
            });
            
            return button;
        };
    
        this._resetActiveButton = () => {
            this._hdmiWindow.get_children().forEach(child => {
                if (child instanceof St.Button && child.has_style_class_name('hdmi-option-hover')) {
                    child.remove_style_class_name('hdmi-option-hover');
                    this._resetInactivityTimeout();
                }
            });
        };
                
        let internalOnly = createOptionItem(
            'video-single-display-symbolic', Gettext.dgettext(this._gettextDomain,"Internal only"), 'internal'
        );
        let mirrorDisplay = createOptionItem(
            'view-mirror-symbolic', Gettext.dgettext(this._gettextDomain,"Mirror"), 'mirror'
        );
        let joinDisplay = createOptionItem(
            'video-joined-displays-symbolic', Gettext.dgettext(this._gettextDomain,"Extended"), 'join'
        );
        let externalOnly = createOptionItem(
            'computer-symbolic', Gettext.dgettext(this._gettextDomain,"External only"), 'external'
        );
    
        this._hdmiWindow.add_child(internalOnly);
        this._hdmiWindow.add_child(mirrorDisplay);
        this._hdmiWindow.add_child(joinDisplay);
        this._hdmiWindow.add_child(externalOnly);

        this._buttonMap.set('internal', internalOnly);
        this._buttonMap.set('external', externalOnly);
        this._buttonMap.set('join', joinDisplay);
        this._buttonMap.set('mirror', mirrorDisplay);

        Main.uiGroup.add_child(this._hdmiWindow);
        
        this._repositionWindow();

        const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
        const targetY = this._hdmiWindow.y; 
        
        this._hdmiWindow.y = workArea.y + workArea.height;
        
        this._hdmiWindow.ease({
            y: targetY,
            opacity: 250,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._resetInactivityTimeout();
            }
        });
        
        this._firstExecution = false;

        this._detectCurrentDisplayMode().then((currentMode) => {
            if (!this._hdmiWindow) return;

            if (currentMode && this._buttonMap.has(currentMode)) {
                this._updateActiveIndicator(currentMode);
                
                const activeButton = this._buttonMap.get(currentMode);
                if (activeButton) {
                    activeButton.grab_key_focus();
                }
            }
        });
        
        this._clickOutsideHandler = global.stage.connect('button-press-event', (actor, event) => {
            if (!this._hdmiWindow) return Clutter.EVENT_PROPAGATE;
            
            let [x, y] = event.get_coords();
            let [wx, wy] = this._hdmiWindow.get_transformed_position();
            let [ww, wh] = this._hdmiWindow.get_size();
            
            if (x < wx || x > wx + ww || y < wy || y > wy + wh) {
                this._removeHdmiWindow();
            }
            
            return Clutter.EVENT_PROPAGATE;
        });
    }


    _resetInactivityTimeout() {
        if (this._inactivityTimeout) {
            GLib.source_remove(this._inactivityTimeout);
            this._inactivityTimeout = null;
        }
        
        this._inactivityTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                this._removeHdmiWindow();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _updateActiveIndicator(newMode) {
        log(`[Indicator] Updating to mode: ${newMode}`);
        
        for (let [mode, button] of this._buttonMap) {
            if (button._indicator) {
                button._indicator.opacity = 0;
            }
        }
        
        if (this._buttonMap.has(newMode)) {
            const activeButton = this._buttonMap.get(newMode);
            if (activeButton._indicator) {
                activeButton._indicator.opacity = 255;
                log(`[Indicator] Showing indicator for ${newMode}`);
            }
        }
    }

    _removeHdmiWindow() {
        if (this._inactivityTimeout) {
            GLib.source_remove(this._inactivityTimeout);
            this._inactivityTimeout = null;
        }        
        if (this._autoApplyTimeout) {
            GLib.source_remove(this._autoApplyTimeout);
            this._autoApplyTimeout = null;
        }
        
        if (this._hdmiWindow) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            
            this._hdmiWindow.ease({
                y: workArea.y + workArea.height,
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._hdmiWindow) {
                        this._hdmiWindow.destroy();
                        this._hdmiWindow = null;
                    }
                }
            });
        }
        
        if (this._clickOutsideHandler) {
            global.stage.disconnect(this._clickOutsideHandler);
            this._clickOutsideHandler = null;
        }

        this._buttonMap.clear();
        this._firstExecution = true;
    }

    async _setDisplayMode(mode) {
        let connect = await this._runCommand();
        
        if (!connect) {
            if (this._hdmiToggle) {
                this._hdmiToggle.setActiveState(false);
            }
            this._notify(
                Gettext.dgettext(this._gettextDomain, "HDMI Disconnected"),
                Gettext.dgettext(this._gettextDomain, "Cannot switch mode without HDMI connection."),
                "video-display-symbolic"
            );
            return;
        }

        if (this._hdmiToggle) {
            this._hdmiToggle.setActiveState(true);
            this._hdmiToggle.updateState(mode);
        }

        const scriptPathSwitch = this.path + '/scripts/hdmi-swicth-python.py';

        switch (mode) {
            case 'internal':
                log("Applying internal display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} internal`);
                break;
            case 'external':
                log("Applying external display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} external`);
                break;
            case 'join':
                log("Applying join display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} join`);
                break;
            case 'mirror':
                log("Applying mirror display mode...");
                GLib.spawn_command_line_async(`python3 ${scriptPathSwitch} mirror`);
                break;
            default:
                log(`Unknown display mode: ${mode}`);
                return;
        }

        log(`Display mode set to: ${mode}`);
        this._removeHdmiWindow();
    }

    _cycleDisplayMode() {
        if (!this._hdmiWindow) return;

        if (this._autoApplyTimeout) {
            GLib.source_remove(this._autoApplyTimeout);
            this._autoApplyTimeout = null;
        }

        const modes = ['internal', 'mirror', 'join', 'external'];
        this._currentModeIndex = ((this._currentModeIndex || 0) + 1) % modes.length;
        const selectedMode = modes[this._currentModeIndex];

        const buttons = this._hdmiWindow.get_children()
            .filter(c => c instanceof St.Button);
            
        if (buttons[this._currentModeIndex]) {
            this._resetActiveButton();
            buttons[this._currentModeIndex].add_style_class_name('hdmi-option-hover');
            this._lastSelectedMode = selectedMode;
            
            this._autoApplyTimeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                2,
                () => {
                    if (this._hdmiWindow && this._lastSelectedMode === selectedMode) {
                        log(`[AUTO] Modo ${selectedMode} aplicado automaticamente`);
                        this._setDisplayMode(selectedMode);
                    }
                    this._autoApplyTimeout = null;
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

   // _getScaledValue(currentHeight) {
   //     const clampedHeight = Math.min(Math.max(currentHeight, 486), 1200);
   //     const scale = (clampedHeight - 486) / (1200 - 486);
        
   //     return {
   //         marginTop: `${Math.round(50 + (150 - 50) * scale)}px`,
   //         iconSize:  `${Math.round(25 + (55 - 25) * scale)}px`,
   //         fontSize:  `${Math.round(15 + (30 - 15) * scale)}px`
   //     };
   // }
}
