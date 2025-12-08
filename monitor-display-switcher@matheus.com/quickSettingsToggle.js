import GObject from 'gi://GObject';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import Gettext from 'gettext';

export const HdmiToggle = GObject.registerClass(
class HdmiToggle extends QuickSettings.QuickMenuToggle {
    _init(extensionApp) {
        super._init({
            title: Gettext.dgettext(extensionApp._gettextDomain,'HDMI Display Mode'),
            iconName: 'video-display-symbolic',
            toggleMode: true,
        });

        this._extensionApp = extensionApp;
        this._items = {};

        this.menu.setHeader('video-display-symbolic', Gettext.dgettext(extensionApp._gettextDomain, 'HDMI Display Mode'));

        this._addMenuItem('internal', Gettext.dgettext(extensionApp._gettextDomain, 'Internal only'), 'video-single-display-symbolic');
        this._addMenuItem('mirror', Gettext.dgettext(extensionApp._gettextDomain, 'Mirror'), 'view-mirror-symbolic');
        this._addMenuItem('join', Gettext.dgettext(extensionApp._gettextDomain, 'Extended'), 'video-joined-displays-symbolic');
        this._addMenuItem('external', Gettext.dgettext(extensionApp._gettextDomain, 'External only'), 'computer-symbolic');
    }

    setActiveState(isActive) {
        this.checked = isActive;
        if (isActive) {
            this.subtitle = null;
        } else {
            this.subtitle = Gettext.dgettext(this._extensionApp._gettextDomain, "HDMI Disconnected");
        }
    }

    _addMenuItem(mode, label, iconName) {
        let item = new PopupMenu.PopupImageMenuItem(label, iconName);
        
        item.connect('activate', () => {
            this._extensionApp._setDisplayMode(mode).catch(e => {
                log(`Error switching display mode: ${e.message}`);
            });
        });

        this.menu.addMenuItem(item);
        this._items[mode] = item;
    }

    updateState(currentMode) {
        for (const [mode, item] of Object.entries(this._items)) {
            if (mode === currentMode) {
                item.setOrnament(PopupMenu.Ornament.CHECK);
            } else {
                item.setOrnament(PopupMenu.Ornament.NONE);
            }
        }
    }
});
