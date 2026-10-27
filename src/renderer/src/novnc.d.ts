declare module '@novnc/novnc' {
  export interface RFBCredentials {
    username?: string
    password?: string
    target?: string
  }

  export interface RFBClipboardEvent extends Event {
    detail: { text: string }
  }

  export interface RFBDisconnectEvent extends Event {
    detail: { clean: boolean }
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: RFBCredentials; shared?: boolean; repeaterID?: string; wsProtocols?: string[] }
    )
    background: string
    clipViewport: boolean
    dragViewport: boolean
    focusOnClick: boolean
    scaleViewport: boolean
    resizeSession: boolean
    showDotCursor: boolean
    viewOnly: boolean
    qualityLevel: number
    compressionLevel: number
    capabilities: { power: boolean }
    disconnect(): void
    sendCredentials(credentials: RFBCredentials): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    sendCtrlAltDel(): void
    focus(): void
    blur(): void
    clipboardPasteFrom(text: string): void
    machineShutdown(): void
    machineReboot(): void
    machineReset(): void
  }
}
