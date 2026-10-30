/**
 * Phone UI served by the remote access server. It is deliberately dependency
 * free: plain HTML, CSS and JavaScript, with no CDN, no analytics and no inline
 * script (the server sends a strict Content-Security-Policy).
 */

export const MOBILE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#e8ecef">
<meta name="color-scheme" content="light">
<title>TagNest</title>
<link rel="stylesheet" href="/mobile.css">
</head>
<body>
<div id="app" class="app">
  <section id="pair-view" class="pair" hidden>
    <div class="pair-card">
      <div class="brand-mark">T</div>
      <h1>TagNest</h1>
      <p class="muted">Your AI workspace, now on this phone.</p>
      <form id="pair-form" autocomplete="off">
        <label for="pair-code">6-digit code</label>
        <input id="pair-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" required>
        <label for="pair-name">This phone</label>
        <input id="pair-name" maxlength="40" placeholder="My phone">
        <button class="primary" type="submit">Pair this phone</button>
        <p id="pair-error" class="error" role="alert"></p>
      </form>
      <p class="fine">In TagNest on the computer, open Settings → Phone access and enter the code shown there. The code expires after 15 minutes.</p>
    </div>
  </section>

  <section id="shell" class="shell" hidden>
    <header class="topbar">
      <div class="brand"><span class="brand-dot"></span>TagNest</div>
      <div class="topbar-right">
        <span id="runtime-pill" class="pill">Linux</span>
        <button id="menu-button" class="icon" aria-label="Tasks and devices">☰</button>
      </div>
    </header>
    <div id="taskbar" class="taskbar"><span id="task-text">Ready</span><button id="stop-button" class="stop" hidden>Stop</button></div>

    <main class="main">
      <section id="chat-view" class="chat-view">
        <div id="messages" class="messages" aria-live="polite"></div>
        <div id="approval" class="approval" hidden></div>
        <form id="composer" class="composer">
          <textarea id="prompt" rows="1" maxlength="20000" placeholder="Ask TagNest to build something in Linux…"></textarea>
          <button id="send-button" class="primary send" type="submit" aria-label="Send">↑</button>
        </form>
      </section>

      <section id="desktop-view" class="desktop-view" hidden>
        <div id="desk-screen" class="desk-screen"></div>
        <button id="keyboard-open" class="keyboard-toggle" type="button" hidden>⌨ Keyboard</button>
        <div id="keyboard-bar" class="keyboard-bar" hidden>
          <input id="keyboard-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type to Linux…">
          <button id="keyboard-close" type="button">Done</button>
        </div>
        <div id="desk-status" class="desk-status">
          <div class="desk-card">
            <h2>Linux desktop</h2>
            <p id="desk-message">Linux is not running.</p>
            <div class="row">
              <button id="desk-start" class="primary" type="button">Start Linux</button>
              <button id="desk-retry" class="ghost" type="button">Reconnect</button>
            </div>
          </div>
        </div>
      </section>
    </main>

    <nav class="tabbar" aria-label="Views">
      <button id="chat-tab" class="tab active" type="button">Chat</button>
      <button id="desktop-tab" class="tab" type="button">Desktop</button>
    </nav>
  </section>

  <div id="sheet" class="sheet" hidden>
    <div class="sheet-card">
      <div class="sheet-head"><strong>Tasks</strong><button id="sheet-close" class="icon" type="button" aria-label="Close">✕</button></div>
      <div id="history" class="history"></div>
      <button id="new-task" class="ghost wide" type="button">New task</button>
      <button id="forget-device" class="danger wide" type="button">Forget this phone</button>
    </div>
  </div>
  <div id="toast" class="toast" hidden></div>
</div>
<script src="/mobile.js"></script>
</body>
</html>`

export const DESKTOP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#151b20">
<title>TagNest desktop</title>
<link rel="stylesheet" href="/mobile.css">
</head>
<body class="desktop-page">
<div id="desk-screen" class="desk-screen"></div>
<button id="keyboard-open" class="keyboard-toggle" type="button" hidden>⌨ Keyboard</button>
<div id="keyboard-bar" class="keyboard-bar" hidden>
  <input id="keyboard-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type to Linux…">
  <button id="keyboard-close" type="button">Done</button>
</div>
<div id="desk-status" class="desk-status">
  <div class="desk-card">
    <h2>TagNest desktop</h2>
    <p id="desk-message">Connecting to Linux…</p>
    <button id="desk-retry" class="primary" type="button">Reconnect</button>
  </div>
</div>
<script src="/desktop.js"></script>
</body>
</html>`

export const MOBILE_CSS = `:root {
  --bg: #e8ecef;
  --surface: #f7f9fa;
  --surface-2: #eef2f4;
  --ink: #172027;
  --ink-2: #4c5a64;
  --ink-3: #7c8992;
  --line: rgba(23, 32, 39, 0.1);
  --accent: #2a343c;
  --ok: #2f6b46;
  --warn: #8a5a19;
  --err: #983a2c;
  --radius: 18px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--ink); }
body { -webkit-text-size-adjust: 100%; overscroll-behavior: none; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
[hidden] { display: none !important; }
.app { display: flex; flex-direction: column; height: 100dvh; min-height: 100%; }
.muted { color: var(--ink-2); }
.fine { color: var(--ink-3); font-size: 11px; line-height: 1.55; }
.error { color: var(--err); font-size: 12px; min-height: 18px; }

.pair { display: grid; place-items: center; padding: 28px 20px; min-height: 100dvh; }
.pair-card { width: min(420px, 100%); padding: 28px 24px; border: 1px solid rgba(255,255,255,.75); border-radius: 24px; background: var(--surface); box-shadow: 0 20px 60px rgba(20,32,42,.12); }
.brand-mark { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 13px; background: var(--accent); color: #f3f6f8; font-weight: 800; font-size: 21px; letter-spacing: -.04em; }
.pair-card h1 { margin: 18px 0 4px; font-size: 28px; letter-spacing: -.04em; }
.pair-card form { display: flex; flex-direction: column; gap: 8px; margin-top: 22px; }
.pair-card label { margin-top: 6px; color: var(--ink-2); font-size: 11px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 12px; background: #fff; padding: 12px 13px; font-size: 16px; outline: none; }
input:focus, textarea:focus { border-color: rgba(42,52,60,.48); box-shadow: 0 0 0 3px rgba(42,52,60,.08); }
#pair-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 24px; letter-spacing: .32em; text-align: center; }
button.primary, button.ghost, button.danger { min-height: 42px; border-radius: 11px; padding: 10px 15px; border: 1px solid transparent; font-size: 14px; font-weight: 650; }
button.primary { background: var(--accent); color: #f3f6f8; }
button.primary:active { background: #111a20; }
button.ghost { background: rgba(255,255,255,.55); border-color: var(--line); color: var(--ink); }
button.danger { background: rgba(152,58,44,.08); border-color: rgba(152,58,44,.2); color: var(--err); }
button:disabled { opacity: .45; cursor: default; }
.wide { width: 100%; margin-top: 8px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.icon { width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.55); font-size: 17px; line-height: 1; }

.shell { display: flex; flex-direction: column; height: 100dvh; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: calc(10px + env(safe-area-inset-top)) 16px 8px; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 16px; font-weight: 750; letter-spacing: -.03em; }
.brand-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px rgba(42,52,60,.1); }
.topbar-right { display: flex; align-items: center; gap: 8px; }
.pill { max-width: 44vw; overflow: hidden; padding: 5px 9px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.52); color: var(--ink-2); font-size: 10.5px; text-overflow: ellipsis; white-space: nowrap; }
.pill.running { color: var(--ok); border-color: rgba(47,107,70,.22); background: rgba(47,107,70,.07); }
.pill.error { color: var(--err); border-color: rgba(152,58,44,.22); background: rgba(152,58,44,.07); }
.taskbar { display: flex; align-items: center; gap: 8px; min-height: 29px; padding: 0 17px 7px; color: var(--ink-2); font-size: 11px; }
.taskbar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stop { margin-left: auto; border: 1px solid rgba(152,58,44,.22); border-radius: 7px; background: rgba(152,58,44,.07); color: var(--err); padding: 3px 8px; font-size: 10.5px; font-weight: 650; }
.main { display: flex; flex: 1; min-height: 0; flex-direction: column; }
.chat-view { display: flex; flex: 1; min-height: 0; flex-direction: column; }
.messages { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 14px 18px; -webkit-overflow-scrolling: touch; }
.msg { display: flex; flex-direction: column; gap: 4px; margin-top: 14px; max-width: 92%; }
.msg.user { align-items: flex-end; margin-left: auto; }
.who { padding: 0 5px; color: var(--ink-3); font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.bubble { padding: 10px 12px; border: 1px solid var(--line); border-radius: 14px 14px 14px 4px; background: var(--surface); font-size: 13.5px; line-height: 1.52; white-space: pre-wrap; word-break: break-word; }
.msg.user .bubble { border-radius: 14px 14px 4px 14px; background: #dfe7eb; }
.msg.error .bubble { color: var(--err); border-color: rgba(152,58,44,.2); background: rgba(152,58,44,.05); }
.msg-note { padding: 0 5px; color: var(--ink-3); font-size: 10px; }
.tool { margin-top: 4px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.46); overflow: hidden; }
.tool summary { display: flex; align-items: center; gap: 7px; padding: 8px 10px; font-size: 11px; font-weight: 600; cursor: pointer; list-style: none; }
.tool summary::-webkit-details-marker { display: none; }
.tool-state { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--ink-3); }
.tool-state.ok { background: var(--ok); }
.tool-state.error, .tool-state.denied { background: var(--err); }
.tool-state.running, .tool-state.awaiting-approval { background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
.tool-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-body { padding: 0 10px 9px; color: var(--ink-2); font-size: 10.5px; }
.tool-body pre { max-height: 180px; margin: 5px 0 0; overflow: auto; padding: 7px; border-radius: 7px; background: rgba(23,32,39,.05); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
.typing { display: inline-flex; gap: 3px; padding: 3px 0; }
.typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--ink-3); animation: bounce 1.2s infinite; }
.typing i:nth-child(2) { animation-delay: .15s; }
.typing i:nth-child(3) { animation-delay: .3s; }
@keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-3px); opacity: 1; } }
@keyframes pulse { 0%, 100% { opacity: .5; } 50% { opacity: 1; } }

.approval { margin: 0 14px 8px; padding: 12px; border: 1px solid rgba(138,90,25,.24); border-radius: 14px; background: #fbf5e9; }
.approval h3 { margin: 0 0 4px; font-size: 12.5px; }
.approval p { margin: 0 0 7px; color: var(--ink-2); font-size: 11px; line-height: 1.45; }
.approval pre { max-height: 110px; margin: 0 0 9px; overflow: auto; padding: 7px; border-radius: 7px; background: rgba(23,32,39,.06); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; white-space: pre-wrap; word-break: break-word; }
.approval .row button { flex: 1; min-height: 38px; font-size: 12px; }

.composer { display: flex; gap: 8px; align-items: flex-end; padding: 8px 12px calc(9px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: rgba(232,236,239,.94); backdrop-filter: blur(12px); }
.composer textarea { min-height: 44px; max-height: 140px; resize: none; padding: 11px 13px; border-radius: 13px; line-height: 1.4; }
.send { flex: none; width: 44px; height: 44px; min-height: 44px; padding: 0; border-radius: 13px; font-size: 21px; font-weight: 500; }
.tabbar { display: flex; gap: 4px; padding: 5px 12px calc(7px + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); background: rgba(238,242,244,.9); backdrop-filter: blur(12px); }
.tab { flex: 1; min-height: 38px; border: 0; border-radius: 10px; background: transparent; color: var(--ink-2); font-size: 12px; font-weight: 650; }
.tab.active { background: rgba(255,255,255,.72); color: var(--ink); box-shadow: 0 1px 2px rgba(20,32,42,.06); }

.desktop-view { position: relative; flex: 1; min-height: 0; background: #0f1519; }
.desk-screen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #151b20; }
.desk-screen canvas { outline: none; touch-action: none; }
.desk-status { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; background: rgba(21,27,32,.72); }
.desk-card { width: min(360px, 92vw); padding: 20px; border: 1px solid rgba(255,255,255,.1); border-radius: 16px; background: rgba(247,249,250,.97); color: var(--ink); box-shadow: 0 20px 60px rgba(0,0,0,.3); }
.desk-card h2 { margin: 0 0 6px; font-size: 16px; letter-spacing: -.02em; }
.desk-card p { margin: 0 0 12px; color: var(--ink-2); font-size: 12px; line-height: 1.5; }

.sheet { position: fixed; inset: 0; z-index: 20; display: flex; align-items: flex-end; background: rgba(16,24,30,.36); backdrop-filter: blur(3px); }
.sheet-card { width: 100%; max-height: 78dvh; overflow: auto; padding: 16px 16px calc(20px + env(safe-area-inset-bottom)); border-radius: 20px 20px 0 0; background: var(--surface); box-shadow: 0 -20px 60px rgba(16,24,30,.18); }
.sheet-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; font-size: 14px; }
.history { display: flex; flex-direction: column; gap: 6px; max-height: 42dvh; overflow: auto; margin-bottom: 10px; }
.history button { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; padding: 9px 11px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.56); text-align: left; }
.history button.active { border-color: rgba(42,52,60,.32); background: #fff; }
.history strong { width: 100%; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.history small { color: var(--ink-3); font-size: 9.5px; }

.toast { position: fixed; left: 50%; bottom: calc(74px + env(safe-area-inset-bottom)); z-index: 30; max-width: 88vw; padding: 8px 12px; border-radius: 9px; background: rgba(23,32,39,.9); color: #f1f5f7; font-size: 11.5px; transform: translateX(-50%); }

.keyboard-toggle {
  position: absolute;
  right: 14px;
  bottom: calc(14px + env(safe-area-inset-bottom));
  z-index: 6;
  padding: 8px 12px;
  border: 1px solid rgba(255,255,255,.2);
  border-radius: 9px;
  background: rgba(15,22,27,.82);
  color: #e8eff4;
  font-size: 11px;
  backdrop-filter: blur(6px);
}

.keyboard-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 8;
  display: flex;
  gap: 6px;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom));
  background: rgba(20,27,33,.96);
  border-top: 1px solid rgba(255,255,255,.1);
}

.keyboard-bar input {
  flex: 1;
  min-width: 0;
  border-color: rgba(255,255,255,.16);
  background: #0f1519;
  color: #e8eff4;
  font-size: 16px;
}

.keyboard-bar button {
  flex: none;
  padding: 0 12px;
  border: 1px solid rgba(255,255,255,.16);
  border-radius: 10px;
  background: rgba(255,255,255,.08);
  color: #e8eff4;
  font-size: 12px;
}

.desktop-page { background: #151b20; overflow: hidden; }
.desktop-page .desk-screen { position: fixed; inset: 0; }
.desktop-page .desk-status { background: rgba(21,27,32,.82); }

@media (min-width: 700px) {
  .shell { max-width: 560px; margin: 0 auto; border-left: 1px solid var(--line); border-right: 1px solid var(--line); background: var(--bg); }
  .pair { background: var(--bg); }
}
`

export const MOBILE_JS = `(function () {
  'use strict'
  var state = null
  var socket = null
  var reconnectTimer = null
  var toastTimer = null
  var lastRenderKey = ''
  var tab = 'chat'
  var desktop = null
  var desktopLoading = false
  var desktopTimer = null

  var pairView = document.getElementById('pair-view')
  var shell = document.getElementById('shell')
  var pairForm = document.getElementById('pair-form')
  var pairCode = document.getElementById('pair-code')
  var pairName = document.getElementById('pair-name')
  var pairError = document.getElementById('pair-error')
  var runtimePill = document.getElementById('runtime-pill')
  var taskText = document.getElementById('task-text')
  var stopButton = document.getElementById('stop-button')
  var messages = document.getElementById('messages')
  var approvalBox = document.getElementById('approval')
  var composer = document.getElementById('composer')
  var prompt = document.getElementById('prompt')
  var sendButton = document.getElementById('send-button')
  var chatView = document.getElementById('chat-view')
  var desktopView = document.getElementById('desktop-view')
  var chatTab = document.getElementById('chat-tab')
  var desktopTab = document.getElementById('desktop-tab')
  var deskScreen = document.getElementById('desk-screen')
  var deskStatus = document.getElementById('desk-status')
  var deskMessage = document.getElementById('desk-message')
  var deskStart = document.getElementById('desk-start')
  var deskRetry = document.getElementById('desk-retry')
  var keyboardOpenButton = document.getElementById('keyboard-open')
  var keyboardBar = document.getElementById('keyboard-bar')
  var keyboardInput = document.getElementById('keyboard-input')
  var keyboardClose = document.getElementById('keyboard-close')
  var sheet = document.getElementById('sheet')
  var historyBox = document.getElementById('history')
  var toastBox = document.getElementById('toast')

  function api(path, options) {
    options = options || {}
    options.credentials = 'same-origin'
    if (options.body && typeof options.body !== 'string') {
      options.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {})
      options.body = JSON.stringify(options.body)
    }
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {} }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('Request failed (' + response.status + ')'))
          error.status = response.status
          throw error
        }
        return data
      })
    })
  }

  function toast(message) {
    toastBox.textContent = message
    toastBox.hidden = false
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { toastBox.hidden = true }, 4200)
  }

  function showPair() {
    if (socket) { try { socket.close() } catch (e) {} socket = null }
    if (reconnectTimer) clearTimeout(reconnectTimer)
    state = null
    shell.hidden = true
    pairView.hidden = false
    pairCode.focus()
  }

  function refresh() {
    return api('/api/state').then(function (next) {
      state = next
      pairView.hidden = true
      shell.hidden = false
      render()
      connectEvents()
    }).catch(function (error) {
      if (error.status === 401) showPair()
      else toast(error.message)
    })
  }

  function connectEvents() {
    if (socket && socket.readyState < 2) return
    var protocol = location.protocol === 'https:' ? 'wss://' : 'ws://'
    socket = new WebSocket(protocol + location.host + '/events')
    socket.onmessage = function (event) {
      var message
      try { message = JSON.parse(event.data) } catch (e) { return }
      if (message.type === 'refresh') refresh()
    }
    socket.onclose = function () {
      socket = null
      if (!state) return
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(function () { if (state) connectEvents() }, 2200)
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function taskLabel(task) {
    var activity = task.activity ? ' · ' + task.activity : ''
    switch (task.status) {
      case 'planning': return 'Planning' + activity
      case 'running': return 'Working' + activity
      case 'waiting-approval': return 'Waiting for your approval'
      case 'cancelling': return 'Stopping…'
      case 'done': return 'Done'
      case 'error': return 'The task failed'
      case 'cancelled': return 'Stopped'
      default: return 'Ready'
    }
  }

  function isBusy() {
    return !!state && ['planning', 'running', 'waiting-approval', 'cancelling'].indexOf(state.task.status) >= 0
  }

  function render() {
    if (!state) return
    var runtime = state.runtime || {}
    var phase = runtime.phase || 'stopped'
    runtimePill.textContent = phase === 'running' ? 'Linux running' : phase === 'error' ? 'Linux error' : phase === 'stopped' ? 'Linux stopped' : 'Linux ' + phase
    runtimePill.className = 'pill ' + (phase === 'running' ? 'running' : phase === 'error' ? 'error' : '')
    taskText.textContent = taskLabel(state.task || { status: 'idle' })
    stopButton.hidden = !isBusy()
    sendButton.disabled = isBusy() || !prompt.value.trim()

    var active = state.conversation
    var list = active ? active.messages : []
    var last = list.length ? list[list.length - 1] : null
    var key = (active ? active.id : '') + '|' + list.length + '|' + (last ? (last.content || '').length + ':' + (last.toolCalls || []).length + ':' + last.error + ':' + last.cancelled : '') + '|' + state.task.status + '|' + (state.approval ? state.approval.id : '') + '|' + (state.conversation ? state.conversation.title : '')
    if (key !== lastRenderKey) {
      lastRenderKey = key
      var nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120
      messages.replaceChildren()
      if (!active || list.length === 0) {
        var empty = el('div', 'msg')
        empty.appendChild(el('div', 'bubble', 'TagNest is connected. Ask for anything that needs a computer; the AI will work inside the Linux machine.'))
        messages.appendChild(empty)
      }
      for (var i = 0; i < list.length; i++) messages.appendChild(renderMessage(list[i], i === list.length - 1))
      if (nearBottom || list.length < 4) messages.scrollTop = messages.scrollHeight
    }
    renderApproval()
    updateDesktopStatus()
  }

  function renderMessage(message, isLast) {
    var wrap = el('article', 'msg ' + (message.role === 'user' ? 'user' : 'assistant') + (message.error ? ' error' : ''))
    wrap.appendChild(el('div', 'who', message.role === 'user' ? 'You' : 'TagNest'))
    var bubble = el('div', 'bubble')
    if (message.content) {
      bubble.textContent = message.content
    } else if (message.role === 'assistant' && isLast && isBusy()) {
      var typing = el('span', 'typing')
      typing.appendChild(el('i')); typing.appendChild(el('i')); typing.appendChild(el('i'))
      bubble.appendChild(typing)
    }
    if (message.error) bubble.textContent = (bubble.textContent ? bubble.textContent + '\\n\\n' : '') + message.error
    if (!bubble.textContent && !bubble.firstChild) bubble.textContent = message.cancelled ? 'Stopped.' : '—'
    wrap.appendChild(bubble)
    var calls = message.toolCalls || []
    for (var i = 0; i < calls.length; i++) wrap.appendChild(renderTool(calls[i]))
    if (message.cancelled) wrap.appendChild(el('div', 'msg-note', 'Stopped by you'))
    return wrap
  }

  function renderTool(call) {
    var details = el('details', 'tool')
    var summary = el('summary')
    summary.appendChild(el('span', 'tool-state ' + call.state))
    summary.appendChild(el('span', 'tool-title', call.title || call.name))
    details.appendChild(summary)
    var body = el('div', 'tool-body')
    if (call.summary) body.appendChild(el('div', '', call.summary))
    if (call.command) {
      var command = el('pre', '', '$ ' + call.command)
      body.appendChild(command)
    }
    if (call.output) {
      var output = el('pre', '', call.output.slice(0, 6000))
      body.appendChild(output)
      if (call.exitCode !== undefined && call.exitCode !== null) body.appendChild(el('div', '', 'Exit code: ' + call.exitCode))
    }
    details.appendChild(body)
    return details
  }

  function renderApproval() {
    var approval = state ? state.approval : null
    approvalBox.replaceChildren()
    if (!approval) { approvalBox.hidden = true; return }
    approvalBox.hidden = false
    approvalBox.appendChild(el('h3', '', approval.title || 'Confirm this operation'))
    approvalBox.appendChild(el('p', '', approval.reason || 'TagNest needs your approval before running this command.'))
    if (approval.command) approvalBox.appendChild(el('pre', '', approval.command))
    var row = el('div', 'row')
    var allow = el('button', 'primary', 'Allow once')
    var deny = el('button', 'ghost', 'Deny')
    allow.type = 'button'; deny.type = 'button'
    allow.onclick = function () { respondApproval(approval.id, true) }
    deny.onclick = function () { respondApproval(approval.id, false) }
    row.appendChild(allow); row.appendChild(deny)
    approvalBox.appendChild(row)
  }

  function respondApproval(id, approved) {
    api('/api/approve', { method: 'POST', body: { requestId: id, approved: approved } })
      .then(refresh)
      .catch(function (error) { toast(error.message) })
  }

  function setTab(next) {
    tab = next
    chatTab.className = 'tab' + (next === 'chat' ? ' active' : '')
    desktopTab.className = 'tab' + (next === 'desktop' ? ' active' : '')
    chatView.hidden = next !== 'chat'
    desktopView.hidden = next !== 'desktop'
    if (next === 'desktop') connectDesktop()
    else disconnectDesktop()
  }

  function updateDesktopStatus() {
    if (!state) return
    var runtime = state.runtime || {}
    if (runtime.phase === 'running') {
      if (desktop && desktop.isConnected) { deskStatus.hidden = true; return }
      if (tab === 'desktop') deskMessage.textContent = desktopLoading ? 'Connecting to the Linux desktop…' : 'The desktop is not connected yet. Tap Reconnect.'
      deskStart.hidden = true
      if (!desktop && !desktopLoading && tab === 'desktop') connectDesktop()
    } else {
      deskStatus.hidden = false
      deskMessage.textContent = runtime.phase === 'stopped' ? 'Linux is not running on the computer.' : (runtime.message || 'Waiting for Linux…')
      deskStart.hidden = runtime.phase !== 'stopped' && runtime.phase !== 'error'
    }
  }

  function sendDesktopKey(keysym) {
    if (!desktop) return
    try { desktop.sendKey(keysym, 'Unidentified', true); desktop.sendKey(keysym, 'Unidentified', false) } catch (e) {}
  }

  function sendDesktopChar(char) {
    var code = char.codePointAt(0)
    if (!code) return
    sendDesktopKey(code >= 0x20 && code <= 0x7e ? code : code > 0x7f ? 0x01000000 | code : 0)
  }

  keyboardOpenButton.addEventListener('click', function () {
    keyboardBar.hidden = false
    keyboardInput.value = ''
    keyboardInput.focus()
  })
  keyboardClose.addEventListener('click', function () {
    keyboardBar.hidden = true
    keyboardInput.blur()
  })
  keyboardInput.addEventListener('input', function () {
    var text = keyboardInput.value
    for (var i = 0; i < text.length; i++) sendDesktopChar(text[i])
    keyboardInput.value = ''
  })
  keyboardInput.addEventListener('keydown', function (event) {
    var special = { Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Delete: 0xffff }
    if (special[event.key]) {
      event.preventDefault()
      sendDesktopKey(special[event.key])
    }
  })

  function connectDesktop() {
    if (!state || state.runtime.phase !== 'running' || desktop || desktopLoading) { updateDesktopStatus(); return }
    desktopLoading = true
    deskStatus.hidden = false
    deskMessage.textContent = 'Connecting to the Linux desktop…'
    import('/novnc/core/rfb.js').then(function (module) {
      if (!state || state.runtime.phase !== 'running' || tab !== 'desktop') { desktopLoading = false; return }
      var RFB = module.default || module.RFB
      var ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/vnc'
      desktop = new RFB(deskScreen, ws, {
        wsProtocols: ['binary'],
        shared: true,
        scaleViewport: true,
        resizeSession: false,
        showDotCursor: true,
        background: '#151b20'
      })
      desktop.addEventListener('connect', function () {
        desktop.isConnected = true
        desktopLoading = false
        deskStatus.hidden = true
        keyboardOpenButton.hidden = false
      })
      desktop.addEventListener('disconnect', function () {
        desktop = null
        desktopLoading = false
        keyboardOpenButton.hidden = true
        keyboardBar.hidden = true
        deskStatus.hidden = false
        deskMessage.textContent = 'The desktop connection closed. Tap Reconnect.'
      })
      desktop.addEventListener('credentialsrequired', function () {
        try { desktop.sendCredentials({ password: '' }) } catch (e) {}
      })
    }).catch(function (error) {
      desktopLoading = false
      deskStatus.hidden = false
      deskMessage.textContent = 'Could not load the desktop viewer: ' + error.message
    })
  }

  function disconnectDesktop() {
    if (desktop) {
      try { desktop.disconnect() } catch (e) {}
      desktop = null
    }
    desktopLoading = false
  }

  function renderHistory() {
    historyBox.replaceChildren()
    var items = (state && state.conversations) || []
    if (items.length === 0) historyBox.appendChild(el('p', 'fine', 'No tasks yet.'))
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var button = el('button', item.id === (state.activeConversationId || '') ? 'active' : '')
        button.type = 'button'
        button.appendChild(el('strong', '', item.title || 'New task'))
        button.appendChild(el('small', '', new Date(item.updatedAt).toLocaleString() + ' · ' + item.messageCount + ' messages'))
        button.onclick = function () {
          api('/api/conversations/select', { method: 'POST', body: { id: item.id } })
            .then(function () { closeSheet(); return refresh() })
            .catch(function (error) { toast(error.message) })
        }
        historyBox.appendChild(button)
      })(items[i])
    }
  }

  function openSheet() {
    renderHistory()
    sheet.hidden = false
  }
  function closeSheet() { sheet.hidden = true }

  pairForm.addEventListener('submit', function (event) {
    event.preventDefault()
    pairError.textContent = ''
    var code = pairCode.value.replace(/\\D/g, '')
    if (code.length !== 6) { pairError.textContent = 'Enter the 6-digit code from TagNest.'; return }
    api('/api/pair', { method: 'POST', body: { code: code, name: pairName.value.trim() || 'Phone' } })
      .then(function () { pairCode.value = ''; return refresh() })
      .catch(function (error) { pairError.textContent = error.message })
  })
  pairCode.addEventListener('input', function () {
    pairCode.value = pairCode.value.replace(/\\D/g, '').slice(0, 6)
    if (pairCode.value.length === 6 && !pairName.value) pairName.focus()
  })

  composer.addEventListener('submit', function (event) {
    event.preventDefault()
    var text = prompt.value.trim()
    if (!text || !state) return
    if (isBusy()) { toast('TagNest is already working. Stop the task first.'); return }
    sendButton.disabled = true
    api('/api/send', { method: 'POST', body: { text: text, conversationId: state.activeConversationId || undefined } })
      .then(function () { prompt.value = ''; prompt.style.height = 'auto'; return refresh() })
      .catch(function (error) { toast(error.message) })
      .finally(function () { sendButton.disabled = false })
  })
  prompt.addEventListener('input', function () {
    prompt.style.height = 'auto'
    prompt.style.height = Math.min(140, prompt.scrollHeight) + 'px'
    sendButton.disabled = isBusy() || !prompt.value.trim()
  })
  prompt.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      composer.requestSubmit()
    }
  })

  stopButton.addEventListener('click', function () {
    stopButton.disabled = true
    api('/api/cancel', { method: 'POST' }).then(refresh).catch(function (error) { toast(error.message) }).finally(function () { stopButton.disabled = false })
  })

  chatTab.addEventListener('click', function () { setTab('chat') })
  desktopTab.addEventListener('click', function () { setTab('desktop') })
  deskRetry.addEventListener('click', function () {
    disconnectDesktop()
    if (state && state.runtime.phase !== 'running') {
      api('/api/runtime/start', { method: 'POST' }).then(function () { deskStatus.hidden = false; deskMessage.textContent = 'Starting Linux…'; return refresh() }).catch(function (error) { toast(error.message) })
    } else {
      connectDesktop()
    }
  })
  deskStart.addEventListener('click', function () {
    deskStart.disabled = true
    api('/api/runtime/start', { method: 'POST' })
      .then(function () { deskMessage.textContent = 'Starting Linux…'; return refresh() })
      .catch(function (error) { toast(error.message) })
      .finally(function () { deskStart.disabled = false })
  })

  document.getElementById('menu-button').addEventListener('click', openSheet)
  document.getElementById('sheet-close').addEventListener('click', closeSheet)
  sheet.addEventListener('click', function (event) { if (event.target === sheet) closeSheet() })
  document.getElementById('new-task').addEventListener('click', function () {
    api('/api/conversations/new', { method: 'POST' })
      .then(function () { closeSheet(); return refresh() })
      .catch(function (error) { toast(error.message) })
  })
  document.getElementById('forget-device').addEventListener('click', function () {
    if (!confirm('Forget this phone? You will need a new pairing code to reconnect.')) return
    api('/api/device/forget', { method: 'POST' }).then(function () { location.reload() }).catch(function (error) { toast(error.message) })
  })

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') disconnectDesktop()
    else if (state && tab === 'desktop') connectDesktop()
  })

  refresh()
})()
`

export const DESKTOP_JS = `(function () {
  'use strict'
  var screen = document.getElementById('desk-screen')
  var statusBox = document.getElementById('desk-status')
  var message = document.getElementById('desk-message')
  var retry = document.getElementById('desk-retry')
  var keyboardOpen = document.getElementById('keyboard-open')
  var keyboardBar = document.getElementById('keyboard-bar')
  var keyboardInput = document.getElementById('keyboard-input')
  var keyboardClose = document.getElementById('keyboard-close')
  var desktop = null
  var loading = false
  var timer = null

  function sendKey(keysym) {
    if (!desktop) return
    try { desktop.sendKey(keysym, 'Unidentified', true); desktop.sendKey(keysym, 'Unidentified', false) } catch (e) {}
  }

  function sendChar(char) {
    var code = char.codePointAt(0)
    if (!code) return
    sendKey(code >= 0x20 && code <= 0x7e ? code : code > 0x7f ? 0x01000000 | code : 0)
  }

  keyboardOpen.addEventListener('click', function () {
    keyboardBar.hidden = false
    keyboardInput.value = ''
    keyboardInput.focus()
  })
  keyboardClose.addEventListener('click', function () {
    keyboardBar.hidden = true
    keyboardInput.blur()
  })
  keyboardInput.addEventListener('input', function () {
    var text = keyboardInput.value
    for (var i = 0; i < text.length; i++) sendChar(text[i])
    keyboardInput.value = ''
  })
  keyboardInput.addEventListener('keydown', function (event) {
    var special = { Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Delete: 0xffff }
    if (special[event.key]) {
      event.preventDefault()
      sendKey(special[event.key])
    }
  })

  function connect() {
    if (desktop || loading) return
    loading = true
    statusBox.hidden = false
    message.textContent = 'Connecting to Linux…'
    import('/novnc/core/rfb.js').then(function (module) {
      var RFB = module.default || module.RFB
      var ws = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/vnc'
      desktop = new RFB(screen, ws, {
        wsProtocols: ['binary'],
        shared: true,
        scaleViewport: true,
        resizeSession: false,
        showDotCursor: true,
        background: '#151b20'
      })
      desktop.addEventListener('connect', function () {
        loading = false
        statusBox.hidden = true
        keyboardOpen.hidden = false
      })
      desktop.addEventListener('disconnect', function () {
        desktop = null
        loading = false
        keyboardOpen.hidden = true
        keyboardBar.hidden = true
        statusBox.hidden = false
        message.textContent = 'The desktop is not available. Start Linux in TagNest, then tap Reconnect.'
        if (timer) clearTimeout(timer)
        timer = setTimeout(connect, 5000)
      })
      desktop.addEventListener('credentialsrequired', function () {
        try { desktop.sendCredentials({ password: '' }) } catch (e) {}
      })
    }).catch(function (error) {
      loading = false
      statusBox.hidden = false
      message.textContent = 'Could not load the viewer: ' + error.message
    })
  }

  retry.addEventListener('click', function () {
    if (desktop) { try { desktop.disconnect() } catch (e) {} desktop = null }
    loading = false
    connect()
  })
  connect()
})()
`
