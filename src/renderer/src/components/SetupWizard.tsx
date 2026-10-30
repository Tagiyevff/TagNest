import type { JSX } from 'react'
import type { SetupStatus } from '@shared/types'
import type { Translate } from '../i18n'
import { Icon } from './Icon'

interface SetupWizardProps {
  t: Translate
  status: SetupStatus
  installing: boolean
  installMessage?: string
  onClose: () => void
  onDismissForever: () => void
  onInstallQemu: () => void
  onOpenSettings: () => void
}

/**
 * First-run checklist. It never blocks the app: every problem has either an
 * action or clear instructions, and the user can continue anyway.
 */
export function SetupWizard(props: SetupWizardProps): JSX.Element {
  const { t, status } = props
  const virtualizationOk = status.acceleration === 'whpx'
  const qemuOk = status.qemuFound

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal setup-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>{t('setupTitle')}</h2>
            <p className="modal-sub">{t('setupSubtitle')}</p>
          </div>
          <button type="button" className="icon-button" onClick={props.onClose} aria-label={t('close')}>
            <Icon name="close" />
          </button>
        </div>

        <div className="setup-list">
          <div className={`setup-item ${virtualizationOk ? 'ok' : 'warn'}`}>
            <span className="setup-icon">
              <Icon name={virtualizationOk ? 'check' : 'alert'} size={14} />
            </span>
            <div className="setup-body">
              <h4>{t('setupVirtualization')}</h4>
              <p>
                {virtualizationOk ? t('setupVirtualizationOk') : t('setupVirtualizationFix')}
              </p>
            </div>
          </div>

          <div className={`setup-item ${qemuOk ? 'ok' : 'warn'}`}>
            <span className="setup-icon">
              <Icon name={qemuOk ? 'check' : 'alert'} size={14} />
            </span>
            <div className="setup-body">
              <h4>{t('setupQemu')}</h4>
              <p>{qemuOk ? t('setupQemuOk') : t('setupQemuMissing')}</p>
              {!qemuOk && status.qemuCanInstall ? (
                <>
                  <button
                    type="button"
                    className="button solid small"
                    disabled={props.installing}
                    onClick={props.onInstallQemu}
                  >
                    {props.installing ? t('qemuInstalling') : t('qemuInstall')}
                  </button>
                  {props.installing ? <span className="mini-spin dark setup-spin" /> : null}
                </>
              ) : null}
              {!qemuOk && !status.qemuCanInstall ? (
                <p className="setup-note">{t('setupQemuManual')}</p>
              ) : null}
              {props.installMessage ? <p className="setup-note">{props.installMessage}</p> : null}
            </div>
          </div>

          <div className={`setup-item ${status.modelReady ? 'ok' : 'warn'}`}>
            <span className="setup-icon">
              <Icon name={status.modelReady ? 'check' : 'alert'} size={14} />
            </span>
            <div className="setup-body">
              <h4>{t('setupModel')}</h4>
              <p>{status.modelReady ? t('setupModelOk') : t('setupModelMissing')}</p>
              {!status.modelReady ? (
                <button type="button" className="button ghost small" onClick={props.onOpenSettings}>
                  {t('setupOpenSettings')}
                </button>
              ) : null}
            </div>
          </div>

          {!status.imageReady ? <p className="setup-note setup-first-run">{t('setupFirstRun')}</p> : null}
        </div>

        <div className="modal-footer setup-footer">
          <button type="button" className="link-button" onClick={props.onDismissForever}>
            {t('setupDismissForever')}
          </button>
          <button type="button" className="button solid" onClick={props.onClose}>
            {t('setupContinue')}
          </button>
        </div>
      </div>
    </div>
  )
}
