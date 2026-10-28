import { useState, type JSX } from 'react'
import type {
  Language,
  ProviderId,
  ProviderTestResult,
  RuntimeState,
  SettingsView,
  UpdateInfo
} from '@shared/types'
import type { Translate } from '../i18n'
import { Icon } from './Icon'

interface SettingsDialogProps {
  t: Translate
  version: string
  settings: SettingsView
  runtime: RuntimeState
  onClose: () => void
  onUpdate: (patch: {
    provider?: ProviderId
    model?: string
    baseUrl?: string
    language?: Language
    memoryMB?: number
    cpus?: number
    diskGB?: number
    autoStartLinux?: boolean
    approveSafeCommands?: boolean
  }) => Promise<void>
  onSetKey: (provider: ProviderId, key: string) => Promise<void>
  onClearKey: (provider: ProviderId) => Promise<void>
  onOpenLogs: () => void
}

const MEMORY_OPTIONS = [2048, 3072, 4096, 6144, 8192]
const CPU_OPTIONS = [1, 2, 3, 4]
const DISK_OPTIONS = [12, 20, 32, 48]

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const { t, settings, runtime } = props
  const provider = settings.providers.find((entry) => entry.id === settings.provider)
  const [model, setModel] = useState(settings.model)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState('')

  const run = async (action: () => Promise<void>, message: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
      setStatus(message)
      setTimeout(() => setStatus(''), 2500)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const saveModel = (): void => {
    if (!model.trim()) {
      setError(t('modelNotConfigured'))
      return
    }
    void run(() => props.onUpdate({ model: model.trim(), baseUrl: baseUrl.trim() }), t('saved'))
  }

  const saveKey = (): void => {
    if (!apiKey.trim()) return
    void run(async () => {
      await props.onSetKey(settings.provider, apiKey.trim())
      setApiKey('')
      setTestResult(null)
    }, t('saved'))
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.tagnest.provider.test())
    } catch (caught) {
      setTestResult({ ok: false, message: cleanError(caught) })
    } finally {
      setTesting(false)
    }
  }

  const checkUpdates = async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateError('')
    setUpdate(null)
    try {
      setUpdate(await window.tagnest.app.checkUpdates())
    } catch (caught) {
      setUpdateError(cleanError(caught))
    } finally {
      setCheckingUpdate(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('settingsTitle')}</h2>
            <p className="modal-sub">{t('localizationNote')}</p>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </div>

        <div className="settings-scroll">
          <section className="settings-section">
            <h3>{t('provider')}</h3>
            <div className="field-grid">
              <label className="field">
                <span>{t('provider')}</span>
                <select
                  value={settings.provider}
                  disabled={busy}
                  onChange={(event) => void run(() => props.onUpdate({ provider: event.target.value as ProviderId }), t('saved'))}
                >
                  {settings.providers.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('model')}</span>
                <input
                  type="text"
                  value={model}
                  spellCheck={false}
                  onChange={(event) => setModel(event.target.value)}
                  onBlur={saveModel}
                  placeholder={provider?.defaultModel || 'model-name'}
                />
              </label>
            </div>

            {provider?.supportsBaseUrl ? (
              <label className="field">
                <span>{t('baseUrl')}</span>
                <input
                  type="url"
                  value={baseUrl}
                  spellCheck={false}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  onBlur={saveModel}
                  placeholder={provider.defaultBaseUrl}
                />
              </label>
            ) : null}

            <div className="api-key-row">
              <label className="field">
                <span>
                  {t('apiKey')}
                  {provider?.requiresApiKey ? null : <em className="optional"> · optional</em>}
                </span>
                <input
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={settings.hasApiKey ? t('apiKeyPlaceholder') : 'sk-…'}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <div className="api-key-actions">
                <button type="button" className="button solid" disabled={!apiKey.trim() || busy} onClick={saveKey}>
                  {t('saveKey')}
                </button>
                {settings.hasApiKey ? (
                  <button
                    type="button"
                    className="button ghost"
                    disabled={busy}
                    onClick={() => void run(() => props.onClearKey(settings.provider), t('keyCleared'))}
                  >
                    {t('clearKey')}
                  </button>
                ) : null}
              </div>
            </div>
            <p className={`key-state ${settings.hasApiKey ? 'ok' : ''}`}>
              <Icon name={settings.hasApiKey ? 'check' : 'alert'} size={13} />
              {settings.hasApiKey ? t('apiKeyStored') : t('apiKeyMissing')}
            </p>
            <p className="field-note">{t('keyNote')}</p>

            <div className="connection-check">
              <button type="button" className="button ghost" disabled={testing || busy} onClick={() => void testConnection()}>
                {testing ? t('testingConnection') : t('testConnection')}
              </button>
              {testResult ? (
                <span className={`connection-state ${testResult.ok ? 'ok' : 'error'}`}>
                  <Icon name={testResult.ok ? 'check' : 'alert'} size={12} />
                  {testResult.message}
                </span>
              ) : (
                <span className="connection-state">{t('connectionNotTested')}</span>
              )}
            </div>
            <p className="field-note">{t('testHint')}</p>

            <div className={`privacy-note ${provider?.privacy === 'local' ? 'local' : ''}`}>
              <strong>{t('privacyTitle')}</strong>
              <p>{provider?.privacy === 'local' ? t('privacyLocal') : t('privacyRemote')}</p>
            </div>
          </section>

          <section className="settings-section">
            <h3>{t('linuxSettings')}</h3>
            <div className="field-grid three">
              <label className="field">
                <span>{t('memory')}</span>
                <select
                  value={settings.memoryMB}
                  disabled={busy}
                  onChange={(event) => void run(() => props.onUpdate({ memoryMB: Number(event.target.value) }), t('saved'))}
                >
                  {MEMORY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GB
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('cpus')}</span>
                <select
                  value={settings.cpus}
                  disabled={busy}
                  onChange={(event) => void run(() => props.onUpdate({ cpus: Number(event.target.value) }), t('saved'))}
                >
                  {CPU_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('disk')}</span>
                <select
                  value={settings.diskGB}
                  disabled={busy}
                  onChange={(event) => void run(() => props.onUpdate({ diskGB: Number(event.target.value) }), t('saved'))}
                >
                  {DISK_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value} GB
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="field-note">{t('memoryHint')} {t('diskHint')}</p>
            {runtime.phase === 'running' ? (
              <p className="field-note">{t('resourcesSummary', { cpus: runtime.cpus, memory: runtime.memoryMB })}</p>
            ) : null}

            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.autoStartLinux}
                onChange={(event) => void run(() => props.onUpdate({ autoStartLinux: event.target.checked }), t('saved'))}
              />
              <span>{t('autoStart')}</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={settings.approveSafeCommands}
                onChange={(event) =>
                  void run(() => props.onUpdate({ approveSafeCommands: event.target.checked }), t('saved'))
                }
              />
              <span>{t('approveSafe')}</span>
            </label>
            <p className="field-note">{t('persistenceNote')}</p>
          </section>

          <section className="settings-section">
            <h3>{t('about')}</h3>
            <div className="about-row">
              <span className="about-version">
                TagNest <strong>{props.version || '—'}</strong>
              </span>
              <button
                type="button"
                className="button ghost"
                disabled={checkingUpdate}
                onClick={() => void checkUpdates()}
              >
                {checkingUpdate ? t('checkingUpdates') : t('checkUpdates')}
              </button>
            </div>
            {update ? (
              <div className={`update-result ${update.updateAvailable ? 'new' : ''}`}>
                <p>
                  <Icon name={update.updateAvailable ? 'alert' : 'check'} size={12} />{' '}
                  {update.latest
                    ? update.updateAvailable
                      ? t('updateAvailable', { version: update.latest })
                      : t('upToDate', { version: update.current })
                    : update.message}
                </p>
                {update.latest && update.updateAvailable ? (
                  <a className="link-button" href={update.url} target="_blank" rel="noreferrer">
                    {t('openRelease')}
                  </a>
                ) : null}
                {update.notes ? (
                  <details className="update-notes">
                    <summary>{t('releaseNotes')}</summary>
                    <pre>{update.notes}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}
            {updateError ? <p className="settings-error">{updateError}</p> : null}
          </section>

          <section className="settings-section compact">
            <label className="field">
              <span>{t('language')}</span>
              <select
                value={settings.language}
                onChange={(event) => void run(() => props.onUpdate({ language: event.target.value as Language }), t('saved'))}
              >
                <option value="en">English</option>
                <option value="az">Azərbaycan dili</option>
              </select>
            </label>
            <button type="button" className="link-button" onClick={props.onOpenLogs}>
              {t('openLogs')}
            </button>
          </section>
        </div>

        <div className="modal-footer">
          <span className={`modal-status ${error ? 'error' : ''}`}>{error || status}</span>
          <div className="modal-actions">
            <button type="button" className="button solid" onClick={props.onClose}>
              {t('close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}
