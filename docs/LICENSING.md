# Licensing and redistribution

TagNest's own source is MIT licensed (see `LICENSE`). It depends on separate open-source projects
with their own terms. TagNest does not include proprietary components.

| Component | Role | License | Redistribution notes |
|---|---|---|---|
| Electron | desktop shell | MIT | Include license notices. |
| React / React DOM | renderer | MIT | — |
| noVNC | VNC client in renderer | MPL-2.0 | Keep MPL notices; modifications to MPL files must be published under MPL. |
| ssh2 | SSH/SFTP client | MIT | Optional native `cpu-features` (Apache-2.0). |
| ws | WebSocket bridge | MIT | — |
| zod | IPC validation | MIT | — |
| QEMU | host emulator | GPL-2.0 | **Not** bundled in this repository. If an installer ships QEMU binaries, provide the corresponding source and GPL notices, and do not claim QEMU is MIT. |
| Alpine Linux | guest OS | mixed free licenses | The app downloads the official cloud image from `dl-cdn.alpinelinux.org`; keep attribution and do not imply endorsement. |
| XFCE | guest desktop | GPL-2.0 / LGPL-2.1 | Distributed inside the guest image on the user's disk. |
| TigerVNC | guest X/VNC server | GPL-2.0 | Installed inside the guest via Alpine packages. |
| Alpine packages (via apk) | guest tooling | per package | Check notices if you redistribute a pre-provisioned disk image. |
| Inter (optional) | UI font | OFL-1.1 | TagNest currently uses system UI fonts and does not ship Inter. |

## Distribution checklist

1. Include `LICENSE` and this document with installers.
2. If bundling QEMU, comply with GPL-2.0: provide the exact corresponding source (or a written
   offer where permitted), license text and build/install information. TagNest's default flow asks
   the user to install QEMU, which avoids bundling it.
3. If bundling `resources/linux/*.qcow2`, include the Alpine license notices and the licenses of
   installed packages. A pre-provisioned image that contains XFCE and TigerVNC redistributes GPL
   software; publish the corresponding sources or a valid written offer.
4. Keep noVNC's MPL-2.0 notices intact.
5. Do not rename or relicense third-party components, and do not state that QEMU or the Alpine
   image are MIT.

## Model providers

Provider services have their own terms and pricing. TagNest does not resell or proxy model access;
the user supplies their own credentials. Ollama and local OpenAI-compatible servers are separate
programs under their own licenses.
