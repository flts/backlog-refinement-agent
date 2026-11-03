import { useEffect, useState } from 'react';
import { defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { parseConfig, serializeConfig, downloadFile } from './config-io';
import { settingsRepository } from './services';
import { errorText, type Notifications } from './useNotifications';

export function useSettings({ setError, setNotice }: Notifications) {
  const [settings, setSettings] = useState<UserSettings>(defaultUserSettings);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsRepository.load()
      .then((stored) => { if (!cancelled) setSettings(stored); })
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not load settings: ${errorText(cause)}`); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  async function save(values: UserSettings) {
    try {
      setSettings(await settingsRepository.save(values));
      setOpen(false); setNotice('Instructions and templates saved locally in IndexedDB.');
    } catch (cause) { setError(`Could not save settings: ${errorText(cause)}`); }
  }

  async function restore() {
    try {
      setSettings(await settingsRepository.restoreDefaults());
      setOpen(false); setNotice('Instructions and templates restored to source defaults.');
    } catch (cause) { setError(`Could not restore defaults: ${errorText(cause)}`); }
  }

  async function importConfig(file?: File) {
    if (!file) return;
    try {
      setSettings(await settingsRepository.save(parseConfig(await file.text())));
      setNotice('Configuration imported.');
    } catch (cause) { setError(`Could not import configuration: ${errorText(cause)}`); }
  }

  function exportConfig() {
    downloadFile('backlog-refinement-config.json', serializeConfig(settings), 'application/json');
  }

  return { settings, loaded, open, setOpen, save, restore, importConfig, exportConfig };
}
