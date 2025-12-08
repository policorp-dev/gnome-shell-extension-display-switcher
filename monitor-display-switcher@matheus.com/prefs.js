import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class DisplaySwitcherPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('HDMI Display Configuration'),
        });

        const row = new Adw.SwitchRow({
            title: _('Show in System Menu'),
            subtitle: _('Shows the projection shortcut in Quick Settings.'),
        });

        group.add(row);
        page.add(group);
        window.add(page);

        settings.bind(
            'show-quick-settings-toggle',
            row,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
    }
}
