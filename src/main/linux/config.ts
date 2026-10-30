/**
 * Pinned Linux base image. The image is Alpine's official "cloudinit" qcow2
 * build (open source, Alpine Linux 3.24, x86_64) and is downloaded once on
 * first launch, then cached. User data lives in a qcow2 overlay on top of it,
 * so replacing or updating the base image never destroys the workspace.
 */
export const BASE_IMAGE = {
  id: 'alpine-3.24.3-x86_64-cloudinit-r0',
  version: '3.24.3',
  fileName: 'alpine-3.24.3-x86_64-cloudinit-r0.qcow2',
  url: 'https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/cloud/alpine-3.24.3-x86_64-cloudinit-r0.qcow2',
  sha512:
    'cf1b95fb4b77d32a9e5c3d02290e203f24907550192fe21819e1abaa28541dab3fe025aa2afa1b952773e3d8e6ea5593bc2e6bfcf398bff886fe5c6f2785f308',
  downloadBytes: 157810688
} as const

export const QEMU_DOWNLOAD_URL = 'https://qemu.weilnetz.de/w64/'

export const GUEST_SSH_PORT = 22
export const GUEST_VNC_PORT = 5901
/** Chromium's DevTools port inside the guest (loopback only, Chrome requires that). */
export const BROWSER_DEBUG_PORT = 9222
/** Guest-side socat bridge that makes the DevTools port reachable from QEMU NAT. */
export const BROWSER_PROXY_PORT = 9223
export const SEED_HOST = '10.0.2.2'
