import { useCallback, useEffect, useState, type JSX } from 'react'
import type {
  AutoUpdateState,
  Language,
  ModelCatalog,
  ModelMode,
  ModelOption,
  ProviderId,
  ProviderModelsResult,
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
    modelMode?: ModelMode
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
const FREE_MODEL_VALUE = '__tagnest_free__'
const CUSTOM_MODEL_VALUE = '__tagnest_custom__'

export function SettingsDialog(props: SettingsDialogProps): JSX.Element {
  const { t, settings, runtime } = props
  const provider = settings.providers.find((entry) => entry.id === settings.provider)
  const requiresApiKey = Boolean(provider?.requiresApiKey)
  const providerLabel = provider?.label ?? settings.provider
  const [model, setModel] = useState(settings.model)
  const [modelMode, setModelMode] = useState<ModelMode>(settings.modelMode)
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [autoUpdate, setAutoUpdate] = useState<AutoUpdateState | null>(null)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  const [modelsLoading, setModelsLoading] = useState(!(requiresApiKey && !settings.hasApiKey))
  const [modelsError, setModelsError] = useState('')
  const [modelsNote, setModelsNote] = useState('')
  const [showManual, setShowManual] = useState(false)

  const applyCatalog = useCallback(
    (result: ProviderModelsResult): void => {
      if (!result.ok || !result.catalog) {
        setCatalog(null)
        setModelsError(result.message ?? t('modelsFailed'))
        return
      }
      setCatalog(result.catalog)
      if (result.catalog.models.length === 0) setModelsNote(t('modelsEmpty'))
      else setModelsNote(t('modelsHint', { provider: providerLabel }))
    },
    [providerLabel, t]
  )

  const loadModels = async (force = false): Promise<ModelCatalog | null> => {
    if (requiresApiKey && !settings.hasApiKey && !force) {
      setCatalog(null)
      setModelsError('')
      setModelsNote('')
      return null
    }
    setModelsLoading(true)
    setModelsError('')
    setModelsNote('')
    try {
      const result = await window.tagnest.provider.models()
      applyCatalog(result)
      return result.ok ? result.catalog ?? null : null
    } catch (caught) {
      setCatalog(null)
      setModelsError(cleanError(caught))
      return null
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    if (requiresApiKey && !settings.hasApiKey) return
    let active = true
    window.tagnest.provider
      .models()
      .then((result) => {
        if (!active) return
        setModelsLoading(false)
        applyCatalog(result)
      })
      .catch((caught: unknown) => {
        if (!active) return
        setModelsLoading(false)
        setCatalog(null)
        setModelsError(cleanError(caught))
      })
    return () => {
      active = false
    }
  }, [applyCatalog, requiresApiKey, settings.hasApiKey])

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

  const saveBaseUrl = (): void => {
    void run(async () => {
      await props.onUpdate({ baseUrl: baseUrl.trim() })
      await loadModels(true)
    }, t('saved'))
  }

  const saveManualModel = (): void => {
    if (!model.trim()) {
      setError(t('modelNotConfigured'))
      return
    }
    void run(async () => {
      await props.onUpdate({ model: model.trim(), modelMode: 'manual' })
      setShowManual(false)
    }, t('saved'))
  }

  const chooseModel = (value: string): void => {
    if (value === CUSTOM_MODEL_VALUE) {
      setShowManual(true)
      setModelMode('manual')
      return
    }
    if (value === FREE_MODEL_VALUE) {
      void run(async () => {
        let current = catalog
        if (!current || current.freeModels.length === 0) {
          current = await loadModels(true)
        }
        const free = current?.freeModels ?? []
        if (free.length === 0) throw new Error(t('freeModelUnavailable'))
        const chosen = free.find((entry) => entry.id === model) ?? free[0]
        setModel(chosen.id)
        setModelMode('free-auto')
        setShowManual(false)
        await props.onUpdate({ model: chosen.id, modelMode: 'free-auto' })
      }, t('saved'))
      return
    }
    setModel(value)
    setModelMode('manual')
    setShowManual(false)
    void run(() => props.onUpdate({ model: value, modelMode: 'manual' }), t('saved'))
  }

  const saveKey = (): void => {
    if (!apiKey.trim()) return
    void run(async () => {
      await props.onSetKey(settings.provider, apiKey.trim())
      setApiKey('')
      setTestResult(null)
      if (settings.hasApiKey) {
        await loadModels(true)
      } else {
        // The parent state update changes hasApiKey; the mount effect below
        // starts the first real model-list request for the new key.
        setModelsLoading(true)
      }
    }, t('saved'))
  }

  const testConnection = async (): Promise<void> => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await window.tagnest.provider.test()
      setTestResult(result)
      if (result.ok) {
        if (modelMode === 'free-auto' && result.model) {
          setModel(result.model)
          await props.onUpdate({ model: result.model, modelMode: 'free-auto' })
        }
        // A verified connection is the moment the real model list is most
        // trustworthy; refresh it so a newly saved key never leaves an empty
        // or stale selector behind.
        await loadModels(true)
      }
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

  const checkAutoUpdate = async (): Promise<void> => {
    setCheckingUpdate(true)
    setUpdateError('')
    try {
      setAutoUpdate(await window.tagnest.updates.check())
    } catch (caught) {
      setUpdateError(cleanError(caught))
    } finally {
      setCheckingUpdate(false)
    }
  }

  useEffect(() => {
    const api = window.tagnest
    if (!api) return
    let active = true
    void api.updates
      .state()
      .then((state) => {
        if (active) setAutoUpdate(state)
      })
      .catch(() => undefined)
    const off = api.onUpdateState(setAutoUpdate)
    return () => {
      active = false
      off()
    }
  }, [])

  const catalogModels = catalog?.models ?? []
  const currentInCatalog = catalogModels.some((entry) => entry.id === model)
  const activeOption =
    modelMode === 'free-auto'
      ? catalog?.freeModels.find((entry) => entry.id === settings.model) ??
        catalog?.freeModels.find((entry) => entry.id === model) ??
        catalog?.freeModels[0]
      : catalogModels.find((entry) => entry.id === model)
  const selectValue =
    modelMode === 'free-auto' ? FREE_MODEL_VALUE : showManual ? CUSTOM_MODEL_VALUE : model

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
              <div className="field">
                <div className="field-head">
                  <span>{t('model')}</span>
                  <button
                    type="button"
                    className="link-button"
                    disabled={
                      modelsLoading || busy || Boolean(provider?.requiresApiKey && !settings.hasApiKey)
                    }
                    onClick={() => void loadModels(true)}
                  >
                    {modelsLoading ? t('loadingModels') : t('refreshModels')}
                  </button>
                </div>
                <select
                  value={selectValue}
                  aria-label={t('model')}
                  disabled={busy}
                  onChange={(event) => chooseModel(event.target.value)}
                >
                  {provider?.id === 'openrouter' ? (
                    <option value={FREE_MODEL_VALUE}>{t('freeAutomatic')}</option>
                  ) : null}
                  {!model && modelMode !== 'free-auto' && !showManual ? (
                    <option value="" disabled>
                      {t('modelNotConfigured')}
                    </option>
                  ) : null}
                  {model && !currentInCatalog && !showManual && modelMode !== 'free-auto' ? (
                    <option value={model}>
                      {model} ({t('modelCurrent')})
                    </option>
                  ) : null}
                  {catalogModels.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {modelOptionLabel(entry)}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL_VALUE}>{t('modelCustom')}</option>
                </select>
                {showManual ? (
                  <>
                    <input
                      type="text"
                      value={model}
                      spellCheck={false}
                      placeholder={provider?.defaultModel || 'model-id'}
                      onChange={(event) => setModel(event.target.value)}
                      onBlur={saveManualModel}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                    <p className="field-note">{t('modelManualHint')}</p>
                  </>
                ) : null}
                {modelMode === 'free-auto' ? (
                  <div className="free-model-note">
                    <p>{t('freeAutomaticHint')}</p>
                    <p>{t('freeModelUsing', { model: settings.model || activeOption?.id || model })}</p>
                  </div>
                ) : activeOption && !showManual ? (
                  <p className="field-note model-meta">{modelDetails(activeOption)}</p>
                ) : null}
                {modelsError ? (
                  <p className="settings-error">{modelsError}</p>
                ) : requiresApiKey && !settings.hasApiKey ? (
                  <p className="field-note">{t('modelsNeedKey')}</p>
                ) : modelsNote ? (
                  <p className="field-note">{modelsNote}</p>
                ) : null}
              </div>
            </div>

            {provider?.supportsBaseUrl ? (
              <label className="field">
                <span>{t('baseUrl')}</span>
                <input
                  type="url"
                  value={baseUrl}
                  spellCheck={false}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  onBlur={saveBaseUrl}
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
                    onClick={() =>
                      void run(async () => {
                        await props.onClearKey(settings.provider)
                        setCatalog(null)
                        setModelsError('')
                        setModelsNote('')
                        setModelsLoading(false)
                      }, t('keyCleared'))
                    }
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
            {autoUpdate ? (
              <div className="auto-update">
                <div className="about-row">
                  <span className="field-label">{t('autoUpdates')}</span>
                  {autoUpdate.status !== 'disabled' ? (
                    <button
                      type="button"
                      className="button ghost"
                      disabled={checkingUpdate || autoUpdate.status === 'downloading'}
                      onClick={() => void checkAutoUpdate()}
                    >
                      {autoUpdate.status === 'checking' ? t('checkingUpdates') : t('checkUpdates')}
                    </button>
                  ) : null}
                </div>
                <p className={`field-note ${autoUpdate.status === 'error' ? 'settings-error' : ''}`}>
                  {autoUpdate.message ?? ''}
                </p>
                {autoUpdate.status === 'ready' ? (
                  <>
                    <button
                      type="button"
                      className="button solid"
                      onClick={() => void window.tagnest.updates.install()}
                    >
                      {t('restartAndInstall')}
                    </button>
                    <p className="field-note">{t('updateInstalledOnQuit')}</p>
                  </>
                ) : null}
              </div>
            ) : null}
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

function modelOptionLabel(option: ModelOption): string {
  const parts = [option.name]
  if (option.id !== option.name) parts.push(option.id)
  if (option.contextLength) parts.push(`${formatTokens(option.contextLength)} context`)
  return parts.join(' · ')
}

function modelDetails(option: ModelOption): string {
  const parts = [option.id]
  if (option.contextLength) parts.push(`${formatTokens(option.contextLength)} tokens`)
  if (option.inputTokenLimit) parts.push(`${formatTokens(option.inputTokenLimit)} input`)
  if (option.capabilities?.length) parts.push(option.capabilities.join(' · '))
  return parts.join(' — ')
}

function formatTokens(value: number): string {
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)
}

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}
