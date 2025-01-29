const GLib = imports.gi.GLib;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell
const Main = imports.ui.main;
const ExtensionUtils = imports.misc.extensionUtils;
const St = imports.gi.St;
const Clutter = imports.gi.Clutter;
const {GObject, GnomeDesktop} = imports.gi;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const Gettext = imports.gettext;
const _ = Gettext.domain('monitordisplay').gettext;


const POPUP_DELAY_TIMEOUT = 2000

function init() {
    _realHasOverview = Main.sessionMode.hasOverview;
    ExtensionUtils.initTranslations(Me.metadata['gettext-domain']);
}

var SwitcherPanel = GObject.registerClass(class SwitcherPanel extends St.Widget {
    _init() {
        super._init({reactive: true})
        this.getModoAtual = 0;
        this.switchTimeout = null
        this.onDisplay = false
        this.monitor = Main.layoutManager.primaryMonitor;
        this.selectedIndex = 0;
        this.panelSize = 295;
        this.items = [];
        this.panel = new St.Bin({
            style: 'background-color: #363437',
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: this.panelSize,
            height: this.monitor.height,
            opacity: 0,
        });
        //	this.add_actor(this.panel)
        this.vbox = new St.BoxLayout({vertical: true});
        this.panel.set_child(this.vbox);
        this.panel.set_position(this.monitor.x + this.monitor.width, this.monitor.y);
        Main.layoutManager.addChrome(this, {
            affectsInputRegion: true,
            trackFullscreen: true,
        });
        Main.uiGroup.add_actor(this);
    }

    notify(msg, details, icon) {
        Main.notify(msg, details, icon);
    }

    resetTimer() {
        // If a timeout is already running, remove it
        if (this.switchTimeout !== null) {
            GLib.source_remove(this.switchTimeout);
        }

        // Set a new timeout of 4 seconds (4000 milliseconds)
        this.switchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
            this.selectOnIdle();
            this.switchTimeout = null; // Reset the timeout variable after execution
            return GLib.SOURCE_REMOVE; // Return GLib.SOURCE_REMOVE to stop further calls
        });
    }

    clearTimeout() {
        if (this.switchTimeout !== null) {
            GLib.source_remove(this.switchTimeout);
            this.switchTimeout = null;
        }
    }
    
    executeCommand(command) {
    	let [, stdout, , exitCode] = GLib.spawn_command_line_sync(command);
    	if (exitCode === 0 && stdout.length > 0) {
        	let decoder = new TextDecoder();
        	return decoder.decode(stdout).trim(); // Retorna o resultado decodificado e sem espaços extras
    	}
    	return null; // Retorna null se o comando falhar ou não houver saída
    }

    runCommand() {
    // Lista de comandos
    	let commands = [
        	"sh -c 'cat /sys/class/drm/*HDMI*/status | grep -w connected'",
         	"sh -c 'cat /sys/class/drm/card*-DP-1/status | grep -w connected'"
     	];

     	for (let command of commands) {
        	 let result = this.executeCommand(command);
         	if (result) {
             	log("Conexão detectada: " + result);
             	return result; // Retorna o primeiro resultado válido
         	}
     	}

     	log("Nenhuma conexão detectada");
     	return null; // Retorna null se nenhum comando tiver sucesso
    }

    changeDisplay(id) {
        let resultadoHdmi = this.runCommand();
        this.getModoAtual = this.modoAtual()
        if (!resultadoHdmi) {
            resultadoHdmi = "null";
        }
        let conectado = "connected";
        if (resultadoHdmi.trim() === conectado) {
            Meta.MonitorManager.get().switch_config(id);
            this.fadeAndOut()
	    if (id === 1){
	       let sessionType = this.executeCommand("sh -c 'echo $XDG_SESSION_TYPE'"); // Obtém o tipo de sessão
	       if (sessionType === "x11") {
		  log("O valor de id é igual a 1 e a sessão do sistema é Xorg");
		  this.executeCommand("sh -c 'xrandr --output eDP --primary'"); // Obtém o tipo de sessão
		  } else {
		     log("Sessão do sistema não é Xorg. Comando não será executado.");
		}
	    }
        } else {
            this.fadeAndOut();
            log("HDMI não conectado");
            this.notify(_("HDMI not connected."), _("You must have HDMI connected."), 'dialog-information');
        }
    }

    selectOnIdle() {
        this.changeDisplay(this.getModoAtual)
        this.panel.opacity = 0;
        this.fadeAndOut()
    }

    modoAtual() {
        const monitorManager = Meta.MonitorManager.get();
        const switchConfig = monitorManager.get_switch_config();
        this.getModoAtual = switchConfig;
        log("Configuração de comutação atual: " + switchConfig);
        return switchConfig;
    }

    switchWidgets(switchConfig) {
        let iconPadrao = 20;
        let corPadrao = "#FFFFFF";
        let corSelecionado = "#0464e4";

        this.createWidget(_('Mirrored'), "view-mirror-symbolic", (index) => this.changeDisplay(index), Meta.MonitorSwitchConfigType.ALL_MIRROR, iconPadrao, switchConfig === Meta.MonitorSwitchConfigType.ALL_MIRROR ? corSelecionado : corPadrao);
        this.createWidget(
            _('Extended'),
            "video-joined-displays-symbolic",
            (index) => this.changeDisplay(index),
            Meta.MonitorSwitchConfigType.ALL_LINEAR,
            iconPadrao,
            (switchConfig === Meta.MonitorSwitchConfigType.ALL_LINEAR) ? corSelecionado : corPadrao
        );
        if (global.backend.get_monitor_manager().has_builtin_panel) {
            this.createWidget(_('Secondary Only'), "computer-symbolic", (index) => this.changeDisplay(index), Meta.MonitorSwitchConfigType.EXTERNAL, iconPadrao, switchConfig === Meta.MonitorSwitchConfigType.EXTERNAL ? corSelecionado : corPadrao);
            this.createWidget(_('Primary Only'), "video-single-display-symbolic", (index) => this.changeDisplay(index), Meta.MonitorSwitchConfigType.BUILTIN, iconPadrao, switchConfig === Meta.MonitorSwitchConfigType.BUILTIN ? corSelecionado : corPadrao);
        }
    }
    updatePanel() {
        if (this.onDisplay == false) {
            this.onDisplay = true
        }
        else {
            this.getModoAtual += 1
        }
        if (this.getModoAtual > 3) {
            this.getModoAtual = 0;
        }
        if (global.backend.get_monitor_manager().has_builtin_panel == false) {
            if (this.getModoAtual > 1) {
                this.getModoAtual = 0;
            }
        }
        this.monitor = Main.layoutManager.primaryMonitor;
        ///this.monitor = Main.layoutManager.monitors[0];
        this.vbox.remove_all_children();
        this.switchWidgets(this.getModoAtual);
        this.panel.set_size(this.panelSize, this.monitor.height);
        this.panel.set_position(this.monitor.x + this.monitor.width, this.monitor.y);
    }
    displaySwitch() {
        this.monitor = Main.layoutManager.primaryMonitor;
        this.updatePanel()
        this.add_actor(this.panel);
        this.panel.width = this.panelSize;
        this.panel.x = this.monitor.x + this.monitor.width - this.panelSize;
        this.panel.y = this.monitor.y;
        this.panel.opacity = 255;

    }
    vfunc_button_press_event(event) {
        this.fadeAndOut();
        return Clutter.EVENT_STOP;  // Indicate that the event is handled
    }

    createWidget(name, img, callback, index, tamanhoIcon, iconColor) {
        let hbox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let percentIcon = 0.085;
        let iconSize = this.monitor.height * percentIcon;

        let blueDot = new St.DrawingArea({
            style_class: 'blue-dot',
            style: 'background-color: blue; width: 10px; height: 10px; border-radius: 5px; margin-right: 10px;'
        });
        hbox.reactive = true;
        if (iconColor == "#0464e4") {
            hbox.add_child(blueDot);
        }
        hbox.connect('button-press-event', () => {
            this.clearTimeout();
            callback(index);
            this.panel.ease({
                x: this.monitor.x + this.monitor.width,
                y: this.monitor.y + 0,
                opacity: 0,
                duration: 500,
                onComplete: () => {
                    this.remove_actor(this.panel);
                }
            });
        });

        let imageWidget = new St.Icon({
            icon_name: img,
            style: 'margin-left:20px; margin-top:20px; margin-bottom:20px',
            style_class: 'system-status-icon',
            icon_size: iconSize
        });

        let labelWidget = new St.Label({
            text: name,
            style: `margin-left: 15px;
					font-size: ` + tamanhoIcon + `px;
					font-weight: bold;
					`,
            y_align: Clutter.ActorAlign.CENTER
        });

        hbox.connect('enter-event', () => {
            this.selected(index);
            hbox.set_style('box-shadow: 0 0 0 #929898; border-radius: 5px;');
            hbox.ease({
                opacity: 127,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this.resetTimer();
                    hbox.ease({
                        opacity: 255,
                        duration: 500,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD
                    });
                }
            });
        });
        hbox.connect('leave-event', () => {
            hbox.set_style(null); // Remove the shadow when hover ends
        });

        hbox.add_child(imageWidget);
        hbox.add_child(labelWidget);
        this.items.push(hbox);
        this.vbox.add_child(hbox);
    }

    selected(index) {
        log(this.items)
    }

    _keyPressHandler(_keysym, _action) {
        throw new GObject.NotImplementedError(`_keyPressHandler in ${this.constructor.name}`);
    }

    vfunc_key_press_event(keyEvent) {
        let keysym = keyEvent.keyval;
        let action = global.display.get_keybinding_action(
            keyEvent.hardware_keycode, keyEvent.modifier_state);


        if (this._keyPressHandler(keysym, action) != Clutter.EVENT_PROPAGATE) {
            this._showImmediately();
            return Clutter.EVENT_STOP;
        }

        // Note: pressing one of the below keys will destroy the popup only if
        // that key is not used by the active popup's keyboard shortcut
        if (keysym === Clutter.KEY_Escape || keysym === Clutter.KEY_Tab)
            this.fadeAndDestroy();

        // Allow to explicitly select the current item; this is particularly
        // useful for no-modifier popups
        if (keysym === Clutter.KEY_space ||
            keysym === Clutter.KEY_Return ||
            keysym === Clutter.KEY_KP_Enter ||
            keysym === Clutter.KEY_ISO_Enter)
            this.fadeAndDestroy();

        return Clutter.EVENT_STOP;
    }

    fadeAndOut() {
        this.onDisplay = true
        this.getModoAtual = this.modoAtual() - 1
        this.panel.ease({
            x: this.monitor.x + this.monitor.width - 270,
            y: this.monitor.y + 0,
            opacity: 0,
            duration: 500,
            onComplete: () => {
                this.panel.width = 0;
                if (this.panel.get_parent()) {
                    this.panel.get_parent().remove_child(this.panel); // Remover o painel se tiver um pai
                    this.remove_actor(this.panel);
                }
                // Remover os widgets criados em createWidget()
                for (let i = 0; i < this.items.length; i++) {
                    let widget = this.items[i];
                    if (widget.get_parent()) {
                        this.vbox.remove_child(widget); // Remover o widget se tiver um pai
                    }
                }
                this.items = []; // Limpar a lista de itens
                this.destroy(); // Você já está chamando destroy(), que também tenta remover this.panel e this.vbox
            }
        });
    }


    destroy() {
        Main.layoutManager.removeChrome(this.panel);
        Main.layoutManager.removeChrome(this.vbox);
        // Limpar ou remover os widgets criados em createWidget()
    }

})
