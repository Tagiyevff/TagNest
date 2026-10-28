import type { JSX } from 'react'

export type IconName =
  | 'plus'
  | 'clock'
  | 'settings'
  | 'send'
  | 'stop'
  | 'play'
  | 'restart'
  | 'terminal'
  | 'maximize'
  | 'minimize'
  | 'clipboard'
  | 'close'
  | 'chevron'
  | 'check'
  | 'x'
  | 'alert'
  | 'trash'
  | 'trash-small'
  | 'image'
  | 'folder'
  | 'file'
  | 'download'
  | 'upload'

const paths: Record<IconName, JSX.Element> = {
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2.1 1.3" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" />
    </>
  ),
  send: <path d="M8 12.8V3.4M4.2 7.1 8 3.3l3.8 3.8" />,
  stop: <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1.4" fill="currentColor" stroke="none" />,
  play: <path d="M5.4 3.5v9l7-4.5z" fill="currentColor" stroke="none" />,
  restart: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.6v3.2h-3.2" />
    </>
  ),
  terminal: (
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="m4.4 6.2 2.2 1.9-2.2 1.9M8.4 10.2h3.2" />
    </>
  ),
  maximize: <path d="M6 2.8H2.8V6M10 2.8h3.2V6M6 13.2H2.8V10M10 13.2h3.2V10" />,
  minimize: <path d="M5.4 2.8v2.6H2.8M10.6 2.8v2.6h2.6M5.4 13.2v-2.6H2.8M10.6 13.2v-2.6h2.6" />,
  clipboard: (
    <>
      <rect x="3.4" y="2.8" width="9.2" height="11" rx="1.6" />
      <path d="M6 2.8V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.8H6Z" />
    </>
  ),
  close: <path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8" />,
  chevron: <path d="m5.4 6.4 2.6 2.6 2.6-2.6" />,
  check: <path d="m3.2 8.3 3.2 3.2 6.4-7" />,
  x: <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />,
  alert: (
    <>
      <path d="M8 2.4 14 13H2L8 2.4Z" />
      <path d="M8 6.4v3.1M8 11.4v.2" />
    </>
  ),
  trash: (
    <>
      <path d="M2.8 4.2h10.4M6.2 4.2V2.8h3.6v1.4M4.2 4.2l.7 9h6.2l.7-9" />
    </>
  ),
  'trash-small': (
    <>
      <path d="M3.6 4.6h8.8M6.4 4.6V3.4h3.2v1.2M4.8 4.6l.6 7.4h5.2l.6-7.4" />
    </>
  ),
  image: (
    <>
      <rect x="2.4" y="3" width="11.2" height="10" rx="1.8" />
      <circle cx="6" cy="6.4" r="1.1" />
      <path d="m3.6 11.4 3.3-3 2.3 2 1.6-1.4 2 1.8" />
    </>
  ),
  folder: <path d="M1.9 4.4A1.4 1.4 0 0 1 3.3 3h3l1.3 1.6h5.1a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4H3.3a1.4 1.4 0 0 1-1.4-1.4V4.4Z" />,
  file: <path d="M4 2.4h5l3 3v8.2H4V2.4Zm5 0v3h3" />,
  download: <path d="M8 2.6v7.6M4.6 7.2 8 10.6l3.4-3.4M3 13.4h10" />,
  upload: <path d="M8 10.6V3M4.6 6.4 8 3l3.4 3.4M3 13.4h10" />
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}
