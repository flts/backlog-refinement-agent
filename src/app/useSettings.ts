import { useEffect, useState } from 'react';
import { defaultUserSettings } from '../infrastructure/storage/SettingsRepository';
import type { UserSettings } from '../infrastructure/storage/SettingsRepository';
import { clearLlmOverrides, emptyRuntimeLlmConfig, loadLlmOverrides, loadRuntimeLlmConfig, resolveLlmConnection, saveLlmOverrides, type LlmOverrides, type RuntimeLlmConfig } from '../infrastructure/llm/llmConfig';
import { parseConfig, serializeConfig, downloadFile } from './config-io';
import { settingsRepository } from './services';
import { errorText, type Notifications } from './useNotifications';

export function useSettings({ setError, setNotice }: Notifications) {
  const [settings, setSettings] = useState<UserSettings>(defaultUserSettings);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [llm, setLlm] = useState<LlmOverrides>(() => loadLlmOverrides());
  const [llmEnvironment, setLlmEnvironment] = useState<RuntimeLlmConfig>(emptyRuntimeLlmConfig);
  const connection = resolveLlmConnection(llm, llmEnvironment);
  const llmReady = Boolean(connection.endpoint && connection.model);

  useEffect(() => {
    let active = true;
    void loadRuntimeLlmConfig().then((runtime) => { if (active) setLlmEnvironment(runtime); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    settingsRepository.load()
      .then((stored) => { if (!cancelled) setSettings(stored); })
      .catch((cause: unknown) => { if (!cancelled) setError(`Could not load settings: ${errorText(cause)}`); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  function saveLlm(values: LlmOverrides) { setLlm(saveLlmOverrides(values)); }

  function clearLlm() { setLlm(clearLlmOverrides()); setNotice('Saved LLM connection removed; runtime configuration values are used again.'); }

  async function save(values: UserSettings, llmValues?: LlmOverrides) {
    try {
      if (llmValues) saveLlm(llmValues);
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

  return { settings, llm, llmEnvironment, llmReady, clearLlm, loaded, open, setOpen, save, restore, importConfig, exportConfig };
}
