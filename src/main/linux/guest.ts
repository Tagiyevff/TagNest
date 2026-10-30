import { DESKTOP_HEIGHT, DESKTOP_WIDTH, GUEST_WORKSPACE } from '../../shared/constants'

/**
 * Everything needed to bring a fresh Alpine guest to the point where it has:
 *  - an unprivileged `tagnest` user with our generated SSH key
 *  - a running TigerVNC + XFCE desktop on port 5901
 *  - the agent workspace at /home/tagnest/workspace
 *
 * The script below runs once, inside the guest, on first boot (cloud-init).
 */

export const GUEST_USER = 'tagnest'
export { DESKTOP_HEIGHT, DESKTOP_WIDTH, GUEST_WORKSPACE }
export const VNC_PORT = 5901
export const PROVISION_MARKER = '/var/lib/tagnest-provisioned'

/**
 * Installs the web browser in a guest that was provisioned by an older
 * release (which did not ship Firefox). Runs as the unprivileged guest user
 * with passwordless sudo, exactly like the provisioning script.
 *
 * The community repository is derived from the existing main line so the
 * command works on any pinned Alpine release instead of hardcoding a version.
 * Returns a shell snippet; failures are reported, never fatal.
 */
export const BROWSER_INSTALL_COMMAND =
  'if ! grep -q /community /etc/apk/repositories; then ' +
  'main=$(grep /main /etc/apk/repositories | head -n1); ' +
  '[ -n "$main" ] && printf "%s\\n" "${main%/main}/community" | sudo -n tee -a /etc/apk/repositories >/dev/null; ' +
  'fi; sudo -n apk update >/dev/null && sudo -n apk add --no-cache firefox'

/**
 * Guest-side helper that opens a URL in Firefox on the TagNest desktop.
 *
 * It reuses the running XFCE session's D-Bus address (read from the session
 * process environment), so a second call opens a window in the existing
 * browser instead of failing with "Firefox is already running". It reports a
 * real success only after a firefox process actually appears.
 */
export const GUEST_OPEN_SCRIPT = `#!/bin/sh
# TagNest: open a URL in the guest browser on the embedded desktop.
set -u
export DISPLAY=:1
export HOME=/home/tagnest
export XDG_RUNTIME_DIR=/run/tagnest
url="\${1:-about:blank}"

if ! command -v firefox >/dev/null 2>&1; then
  echo "firefox is not installed in this guest" >&2
  exit 3
fi

session=$(pgrep -u tagnest -x xfce4-session | head -n1)
if [ -n "$session" ]; then
  bus=$(tr '\\0' '\\n' < "/proc/$session/environ" 2>/dev/null | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -n1)
  if [ -n "$bus" ]; then export DBUS_SESSION_BUS_ADDRESS="$bus"; fi
fi

log=/tmp/tagnest-open.log
# No --new-window: with the session bus above, Firefox opens the URL as a new
# tab in the window the user already has, like a person would.
firefox "$url" >"$log" 2>&1 &
i=0
while [ "$i" -lt 20 ]; do
  if pgrep -u tagnest -x firefox >/dev/null 2>&1; then
    echo "opened $url"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "firefox did not start:" >&2
tail -n 20 "$log" >&2
exit 1
`

/**
 * Installs GUEST_OPEN_SCRIPT at /usr/local/bin/tagnest-open. Runs on every
 * boot so the helper always matches the app version; base64 keeps the transfer
 * free of quoting problems.
 */
export function guestHelperInstallCommand(): string {
  const encoded = Buffer.from(GUEST_OPEN_SCRIPT, 'utf8').toString('base64')
  return (
    `printf '%s' '${encoded}' | base64 -d | sudo -n tee /usr/local/bin/tagnest-open >/dev/null && ` +
    `sudo -n chmod 755 /usr/local/bin/tagnest-open && echo installed`
  )
}

export const PROVISION_SCRIPT = `#!/bin/sh
# TagNest guest provisioning (first boot). Safe to re-run.
set -eu

post() {
  wget -q -O /dev/null "http://10.0.2.2:$TAGNEST_SEED_PORT/progress?step=$1" || true
}

echo "[tagnest] provisioning start"
post packages
apk update
# Bring up SSH first so TagNest can supervise the longer desktop install.
apk add --no-cache openssh sudo bash curl ca-certificates

post account
echo 'tagnest:tagnest-unlocked-6d2f1a' | chpasswd
install -d -m 755 -o tagnest -g tagnest ${GUEST_WORKSPACE}
chown -R tagnest:tagnest /home/tagnest
sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
rc-update add sshd default || true
rc-service sshd restart || true

post desktop
apk add --no-cache \\
  dbus dbus-openrc dbus-x11 \\
  xauth xrandr xdotool util-linux \\
  tigervnc \\
  xfce4 xfce4-terminal xfce4-screenshooter thunar mousepad ristretto \\
  adwaita-icon-theme font-dejavu font-noto \\
  firefox socat
rc-update add dbus default || true
rc-service dbus start || true

install -d -m 755 /run/tagnest
chown tagnest:tagnest /run/tagnest

cat > /usr/local/bin/tagnest-desktop <<'LAUNCH'
#!/bin/sh
# OpenRC runs this as root; drop to the unprivileged desktop user.
pkill -u tagnest -x Xvnc 2>/dev/null || true
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true
# /run is a tmpfs, so this directory does not survive a reboot. The launcher
# runs as root; the unprivileged session user cannot create it itself.
mkdir -p /run/tagnest
chown tagnest:tagnest /run/tagnest
chmod 700 /run/tagnest
exec setpriv --reuid=tagnest --regid=tagnest --init-groups /usr/local/bin/tagnest-session
LAUNCH
chmod 755 /usr/local/bin/tagnest-desktop

cat > /usr/local/bin/tagnest-session <<'SESSION'
#!/bin/sh
# Runs as the unprivileged guest user: Xvnc display :1 + XFCE session.
export HOME=/home/tagnest
export DISPLAY=:1
export XDG_RUNTIME_DIR=/run/tagnest
export XDG_CONFIG_HOME=/home/tagnest/.config
export XDG_CACHE_HOME=/home/tagnest/.cache
export XDG_DATA_HOME=/home/tagnest/.local/share
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME"

Xvnc :1 -geometry ${DESKTOP_WIDTH}x${DESKTOP_HEIGHT} -depth 24 -SecurityTypes None -AlwaysShared \\
  -rfbport ${VNC_PORT} -desktop TagNest >"$XDG_RUNTIME_DIR/xvnc.log" 2>&1 &
XVNC_PID=$!
trap 'kill "$XVNC_PID" 2>/dev/null || true' EXIT

i=0
while [ "$i" -lt 75 ]; do
  DISPLAY=:1 xrandr --query >/dev/null 2>&1 && break
  i=$((i + 1))
  sleep 0.2
done

exec dbus-run-session -- startxfce4
SESSION
chmod 755 /usr/local/bin/tagnest-session

cat > /etc/init.d/tagnest-desktop <<'INIT'
#!/sbin/openrc-run
description="TagNest graphical desktop (Xvnc + XFCE)"
command="/usr/local/bin/tagnest-desktop"
command_background="yes"
pidfile="/run/tagnest-desktop.pid"
output_log="/var/log/tagnest-desktop.log"
error_log="/var/log/tagnest-desktop.log"
depend() {
  need net
  after sshd
}
stop() {
  ebegin "Stopping TagNest desktop"
  start-stop-daemon --stop --pidfile "$pidfile" --retry TERM/5/KILL/5 2>/dev/null || true
  pkill -u tagnest -x Xvnc 2>/dev/null || true
  pkill -u tagnest -x xfce4-session 2>/dev/null || true
  eend 0
}
INIT
chmod 755 /etc/init.d/tagnest-desktop
rc-update add tagnest-desktop default || true
rc-service tagnest-desktop restart || true

# Open a terminal on login so the desktop is immediately usable.
install -d -m 755 -o tagnest -g tagnest /home/tagnest/.config/autostart
cat > /home/tagnest/.config/autostart/tagnest-terminal.desktop <<'AUTO'
[Desktop Entry]
Type=Application
Name=Terminal
Exec=xfce4-terminal --maximize
Terminal=false
OnlyShowIn=XFCE;
AUTO

cat > /home/tagnest/README.txt <<'README'
TagNest Linux workspace
=======================

You are inside a real Alpine Linux virtual machine running locally on this PC.
Everything the AI does happens here, inside this machine.

  ~/workspace   Files the AI works on (agent file tools are confined here)
  Terminal      Passwordless sudo is available to the AI only after you approve
                elevated commands in the chat panel.
README

chown -R tagnest:tagnest /home/tagnest
chmod 644 /var/log/tagnest-desktop.log 2>/dev/null || true

post done
echo done > ${PROVISION_MARKER}
echo "[tagnest] provisioning complete"
`

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line.length ? pad + line : line))
    .join('\n')
}

export function buildUserData(options: {
  sshPublicKey: string
  seedPort: number
  instanceId: string
}): string {
  const script = PROVISION_SCRIPT.replaceAll('$TAGNEST_SEED_PORT', String(options.seedPort))
  return `#cloud-config
hostname: tagnest
users:
  - name: ${GUEST_USER}
    groups: wheel
    shell: /bin/ash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${options.sshPublicKey}
ssh_pwauth: false
chpasswd:
  expire: false
  list: |
    ${GUEST_USER}:tagnest-unlocked-6d2f1a
write_files:
  - path: /usr/local/sbin/tagnest-provision
    permissions: '0755'
    content: |
${indent(script, 6)}
runcmd:
  - /usr/local/sbin/tagnest-provision >> /var/log/tagnest-provision.log 2>&1
`
}

export function buildMetaData(instanceId: string): string {
  return `instance-id: ${instanceId}
local-hostname: tagnest
`
}
