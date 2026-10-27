/// <reference types="vite/client" />
import type { TagNestApi } from '@shared/api'

declare global {
  interface Window {
    tagnest: TagNestApi
  }
}
