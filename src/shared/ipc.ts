import { z } from 'zod'
import type { AppSettings, Language, ProviderId } from './types'

export { IPC } from './channels'

export const PROVIDER_IDS: [ProviderId, ...ProviderId[]] = [
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'ollama',
  'custom'
]

export const languageSchema = z.enum(['en', 'az'])

export const settingsPatchSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    modelMode: z.enum(['manual', 'free-auto']).optional(),
    baseUrl: z.string().trim().max(500).optional(),
    language: languageSchema.optional(),
    memoryMB: z.number().int().min(1024).max(16384).optional(),
    cpus: z.number().int().min(1).max(8).optional(),
    diskGB: z.number().int().min(8).max(128).optional(),
    autoStartLinux: z.boolean().optional(),
    approveSafeCommands: z.boolean().optional(),
    launchAtLogin: z.boolean().optional()
  })
  .strict()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export const setApiKeySchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    apiKey: z.string().min(1).max(4096)
  })
  .strict()

export const providerOnlySchema = z.object({ provider: z.enum(PROVIDER_IDS) }).strict()

export const idSchema = z.object({ id: z.string().min(1).max(120) }).strict()

export const sendMessageSchema = z
  .object({
    conversationId: z.string().min(1).max(120).optional(),
    text: z.string().min(1).max(20000)
  })
  .strict()

export const approvalResponseSchema = z
  .object({
    requestId: z.string().min(1).max(120),
    approved: z.boolean()
  })
  .strict()

export const retrySchema = z.object({ conversationId: z.string().min(1).max(120) }).strict()

export const activeConversationSchema = z
  .object({ id: z.string().min(1).max(120).nullable() })
  .strict()

export const workspaceListSchema = z
  .object({ path: z.string().max(500).optional() })
  .strict()

const uploadFileSchema = z
  .object({
    name: z.string().min(1).max(255),
    relativePath: z.string().min(1).max(1024).optional(),
    data: z.instanceof(Uint8Array)
  })
  .strict()

export const workspaceUploadSchema = z
  .object({
    files: z.array(uploadFileSchema).max(200).optional(),
    hostPaths: z.array(z.string().min(1).max(4096)).max(200).optional(),
    pick: z.boolean().optional()
  })
  .strict()

export const workspaceDownloadSchema = z.object({ path: z.string().min(1).max(500) }).strict()

export const remoteEnableSchema = z
  .object({
    mode: z.enum(['tunnel', 'lan', 'custom']),
    customUrl: z.string().trim().max(500).optional()
  })
  .strict()

export type RemoteEnableInput = z.infer<typeof remoteEnableSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  modelMode: 'manual',
  baseUrl: '',
  language: 'en',
  memoryMB: 3072,
  cpus: 2,
  diskGB: 20,
  autoStartLinux: true,
  approveSafeCommands: true,
  launchAtLogin: false
}

export function isLanguage(value: string | undefined): value is Language {
  return value === 'en' || value === 'az'
}
