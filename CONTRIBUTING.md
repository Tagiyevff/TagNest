# Contributing

Thanks for helping with TagNest. A few practical notes:

## Setup

```bash
npm install
npm run dev
```

Install QEMU first (`winget install SoftwareFreedomConservancy.QEMU`) if you want to run the Linux
environment. Without QEMU the UI still starts and shows an actionable error.

## Before opening a pull request

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

If you change the Linux runtime, run `npm run smoke:linux` on a machine with QEMU and WHPX. It
boots a real VM, exercises SSH/SFTP/desktop/VNC/cancellation and restarts. Changes to the agent loop
should also run `npm run smoke:agent` after a VM has been provisioned.

## Rules of thumb

- Keep privileged work in the main process. The renderer never gets Node access.
- Validate IPC input with zod and never trust paths from the renderer.
- File tools stay inside `/home/tagnest/workspace`. Commands go through the approval policy.
- Never log secrets; run new log lines through `redactSecrets`.
- Do not claim a feature works unless it was exercised. Update `docs/VALIDATION.md` when you verify
  something new.
- Preserve the split-panel layout and the restrained visual style (no gradients, glassmorphism or
  decorative dashboards).

## Adding a provider

Implement `ProviderAdapter` in `src/main/agent/providers/`, map the neutral transcript to the real
API, add it to `PROVIDERS` and `createProviderAdapter`, and add a mock-server test under
`src/main/agent/providers/providers.test.ts`.
