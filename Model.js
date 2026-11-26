// Pure JS helpers shared by Panel.qml and tests/run.mjs.
// Neutralizes markup-shaped input and bounds untrusted data from the TV.

function safeText(raw, maxLen) {
  var s = String(raw === undefined || raw === null ? "" : raw)
  // Neutralize HTML/QML rich-text markup characters and control chars.
  s = s.replace(/[\u0000-\u001f\u007f]/g, " ")
       .replace(/[<>]/g, "")
       .replace(/&/g, "and")
       .replace(/\s+/g, " ")
       .trim()
  var limit = maxLen || 48
  return s.length > limit ? s.slice(0, limit - 1) + "…" : s
}

function isValidIpv4(ip) {
  var s = String(ip || "").trim()
  var parts = s.split(".")
  if (parts.length !== 4) return false
  for (var i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false
    var n = Number(parts[i])
    if (n < 0 || n > 255) return false
  }
  return true
}

function isValidHdmiInput(inputId) {
  var s = String(inputId || "").trim()
  if (s === "") return true
  return /^[A-Za-z0-9_.-]{1,24}$/.test(s)
}

function isProfileActive(activeProfile, target) {
  var a = String(activeProfile || "").toLowerCase().replace(/[\s_-]+/g, "")
  var b = String(target || "").toLowerCase().replace(/[\s_-]+/g, "")
  return a !== "" && a === b
}

function parseStatePayload(raw) {
  var txt = String(raw || "").trim()
  if (txt === "") return null
  var data = JSON.parse(txt)
  if (!data || typeof data !== "object") return null

  var cleanInputs = []
  if (Array.isArray(data.inputs)) {
    for (var i = 0; i < Math.min(data.inputs.length, 12); i++) {
      var item = data.inputs[i]
      if (!item || !item.id) continue
      cleanInputs.push({
        id: safeText(item.id, 24),
        label: safeText(item.label || item.id, 32),
        appId: safeText(item.appId || "", 64),
        connected: Boolean(item.connected)
      })
    }
  }

  return {
    configured: data.configured === undefined ? true : Boolean(data.configured),
    online: Boolean(data.online),
    reachable: Boolean(data.reachable),
    pinMismatch: Boolean(data.pinMismatch),
    pairingRequired: Boolean(data.pairingRequired),
    powerState: safeText(data.powerState || "Standby", 32),
    screenOff: Boolean(data.screenOff),
    volume: Math.max(0, Math.min(100, Math.round(Number(data.volume) || 0))),
    muted: Boolean(data.muted),
    soundOutput: safeText(data.soundOutput || "", 32),
    foregroundAppId: safeText(data.foregroundAppId || "", 64),
    pcInputId: safeText(data.pcInputId || "", 24),
    hyprmonAvailable: Boolean(data.hyprmonAvailable),
    activeProfile: safeText(data.activeProfile || "", 32),
    pcAudioOnTv: Boolean(data.pcAudioOnTv),
    pcAudioAvailable: Boolean(data.pcAudioAvailable),
    pcAudioSinkName: safeText(data.pcAudioSinkName || "", 48),
    inputs: cleanInputs
  }
}

function parseAppsPayload(raw) {
  var txt = String(raw || "").trim()
  if (txt === "") return null
  var list = JSON.parse(txt)
  if (!Array.isArray(list)) return null
  var clean = []
  for (var i = 0; i < Math.min(list.length, 24); i++) {
    var item = list[i]
    if (!item || !item.id || !item.title) continue
    clean.push({
      id: safeText(item.id, 64),
      title: safeText(item.title, 32)
    })
  }
  return clean
}

function activeSourceLabel(online, foregroundAppId, inputs, apps) {
  if (!online || !foregroundAppId) return ""
  var inp = Array.isArray(inputs) ? inputs : []
  for (var i = 0; i < inp.length; i++) {
    if (inp[i].appId === foregroundAppId) return safeText(inp[i].label, 28)
  }
  var appList = Array.isArray(apps) ? apps : []
  for (var j = 0; j < appList.length; j++) {
    if (appList[j].id === foregroundAppId) return safeText(appList[j].title, 28)
  }
  return ""
}
