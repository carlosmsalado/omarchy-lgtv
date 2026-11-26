import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

Panel {
  id: root
  moduleName: "carlosmsalado.lgtv"
  ipcTarget: "carlosmsalado.lgtv"
  manageIpc: false

  readonly property string helperPath: Qt.resolvedUrl("lgtv-helper.sh").toString().replace(/^file:\/\//, "")
  readonly property int refreshIntervalSec: Math.max(5, Math.min(300, Number(setting("refreshIntervalSec", 25)) || 25))
  readonly property string hyprmonProfileOn: safeText(setting("hyprmonProfileOn", "3 pantallas"), 40)
  readonly property string hyprmonProfileOff: safeText(setting("hyprmonProfileOff", "2 pantallas"), 40)

  property bool configured: true
  property bool online: false
  property bool reachable: false
  property bool pinMismatch: false
  property bool pairingRequired: false
  property string powerState: "Standby"
  property bool screenOff: false
  property int volume: 0
  property bool muted: false
  property string soundOutput: ""
  property string foregroundAppId: ""
  property var inputs: []
  property string pcInputId: ""
  property var apps: []
  property bool appsLoaded: false
  property bool hyprmonAvailable: false
  property string activeProfile: ""
  property bool pcAudioOnTv: false
  property bool pcAudioAvailable: false
  property string pcAudioSinkName: ""
  property bool busy: false
  property string errorMessage: ""
  property bool remoteExpanded: false
  property real lastWheelMs: 0

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color accent: Commons.Color.accent
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property bool tvLit: configured && online && !screenOff
  readonly property color barIconColor: {
    if (pinMismatch) return urgent
    if (tvLit) return barForeground
    if (configured && online && screenOff) return Qt.darker(barForeground, 1.25)
    return Qt.darker(barForeground, 1.6)
  }

  Commons.Translations {
    id: strings
    directory: Qt.resolvedUrl("i18n")
  }

  function safeText(raw, maxLen) {
    var s = String(raw === undefined || raw === null ? "" : raw)
    s = s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim()
    var limit = maxLen || 48
    return s.length > limit ? s.slice(0, limit - 1) + "…" : s
  }

  function statusLabel() {
    if (busy) return strings.t("status.busy")
    if (!configured) return strings.t("status.unconfigured")
    if (pinMismatch) return strings.t("status.pinMismatch")
    if (pairingRequired) return strings.t("status.pairingRequired")
    if (!online) return strings.t("status.standby")
    if (screenOff) return strings.t("status.screenOff")
    return strings.t("status.active")
  }

  function activeSourceLabel() {
    if (!online || !foregroundAppId) return ""
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].appId === foregroundAppId) return safeText(inputs[i].label, 28)
    }
    for (var j = 0; j < apps.length; j++) {
      if (apps[j].id === foregroundAppId) return safeText(apps[j].title, 28)
    }
    return ""
  }

  function headerSubtitle() {
    var base = statusLabel()
    var src = activeSourceLabel()
    return src !== "" && !busy ? base + " · " + src : base
  }

  function tvIcon() {
    if (tvLit) return "\udb81\udff4"
    if (configured && online && screenOff) return "\udb83\udd90"
    return "\udb81\udff4"
  }

  function parseProbe(raw) {
    var txt = String(raw || "").trim()
    if (txt === "") return
    try {
      var data = JSON.parse(txt)
      if (data.configured !== undefined) configured = Boolean(data.configured)
      reachable = Boolean(data.reachable)
      pinMismatch = Boolean(data.pinMismatch)
      if (!configured || !reachable) {
        online = false
        screenOff = false
      } else if (!online) {
        online = true
      }
      if (data.hyprmonAvailable !== undefined) hyprmonAvailable = Boolean(data.hyprmonAvailable)
      if (data.activeProfile !== undefined) activeProfile = safeText(data.activeProfile, 32)
      if (data.pcAudioOnTv !== undefined) pcAudioOnTv = Boolean(data.pcAudioOnTv)
      if (data.pcAudioAvailable !== undefined) pcAudioAvailable = Boolean(data.pcAudioAvailable)
      if (data.pcAudioSinkName !== undefined) pcAudioSinkName = safeText(data.pcAudioSinkName, 48)
    } catch (e) {}
  }

  function parseState(raw) {
    var txt = String(raw || "").trim()
    if (txt === "") return
    try {
      var data = JSON.parse(txt)
      if (data.configured !== undefined) configured = Boolean(data.configured)
      online = Boolean(data.online)
      reachable = Boolean(data.reachable)
      pinMismatch = Boolean(data.pinMismatch)
      pairingRequired = Boolean(data.pairingRequired)
      powerState = safeText(data.powerState || "Standby", 32)
      screenOff = Boolean(data.screenOff)
      volume = Math.max(0, Math.min(100, Math.round(Number(data.volume) || 0)))
      muted = Boolean(data.muted)
      soundOutput = safeText(data.soundOutput || "", 32)
      foregroundAppId = safeText(data.foregroundAppId || "", 64)
      pcInputId = safeText(data.pcInputId || "", 24)
      if (data.hyprmonAvailable !== undefined) hyprmonAvailable = Boolean(data.hyprmonAvailable)
      activeProfile = safeText(data.activeProfile || "", 32)
      pcAudioOnTv = Boolean(data.pcAudioOnTv)
      pcAudioAvailable = Boolean(data.pcAudioAvailable)
      pcAudioSinkName = safeText(data.pcAudioSinkName || "", 48)
      if (Array.isArray(data.inputs)) {
        var cleanInputs = []
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
        inputs = cleanInputs
      }
      if (root.opened && online && !appsLoaded) refreshApps(false)
    } catch (e) {}
  }

  function parseApps(raw) {
    var txt = String(raw || "").trim()
    if (txt === "") return
    try {
      var list = JSON.parse(txt)
      if (!Array.isArray(list)) return
      var clean = []
      for (var i = 0; i < Math.min(list.length, 24); i++) {
        var item = list[i]
        if (!item || !item.id || !item.title) continue
        clean.push({
          id: safeText(item.id, 64),
          title: safeText(item.title, 32)
        })
      }
      apps = clean
      appsLoaded = true
    } catch (e) {}
  }

  function refreshProbe() {
    if (probeProc.running || stateProc.running || root.opened) return
    probeProc.running = true
  }

  function refreshState() {
    if (stateProc.running) return
    stateProc.running = true
  }

  function refreshApps(force) {
    if (appsProc.running || !online) return
    appsProc.command = force ? [helperPath, "apps", "--force"] : [helperPath, "apps"]
    appsProc.running = true
  }

  function runAction(args, showBusy) {
    if (actionProc.running) return
    errorMessage = ""
    if (showBusy !== false) busy = true
    actionProc.command = [helperPath].concat(args)
    actionProc.running = true
  }

  function runQuickVolume(delta) {
    if (volProc.running || !online) return
    volProc.command = [helperPath, "tv", "volume", delta > 0 ? "up" : "down"]
    volProc.running = true
  }

  function togglePower() {
    if (!configured) return
    if (online) runAction(["tv", "off"], true)
    else runAction(["tv", "wake-only"], true)
  }

  function toggleScreen() {
    if (!configured) return
    if (!online) {
      runAction(["tv", "wake-only"], true)
      return
    }
    runAction(["tv", screenOff ? "screen-on" : "screen-off"], true)
  }

  function setVolume(val) {
    var v = Math.max(0, Math.min(100, Math.round(val)))
    volume = v
    runAction(["tv", "volume", String(v)], false)
  }

  function toggleMute() {
    muted = !muted
    runAction(["tv", "mute", "toggle"], false)
  }

  function setSoundOutput(outId) {
    soundOutput = outId
    runAction(["tv", "sound-output", outId], false)
  }

  function switchInput(inputId) {
    runAction(["tv", "input", inputId], true)
  }

  function launchApp(appId) {
    runAction(["tv", "launch", appId], true)
  }

  function sendMedia(cmd) {
    runAction(["tv", "media", cmd], false)
  }

  function sendKey(keyName) {
    runAction(["tv", "key", keyName], false)
  }

  function applyProfile(profileName) {
    runAction(["profile", profileName], true)
  }

  function togglePcAudio() {
    runAction(["pc-audio-toggle"], false)
  }

  function isProfileActive(target) {
    var a = activeProfile.toLowerCase().replace(/[\s_-]+/g, "")
    var b = String(target).toLowerCase().replace(/[\s_-]+/g, "")
    return a !== "" && a === b
  }

  ShellIpc {
    target: "carlosmsalado.lgtv"

    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function powerToggle(): void { root.togglePower() }
    function screenToggle(): void { root.toggleScreen() }
    function volumeUp(): void { root.runQuickVolume(1) }
    function volumeDown(): void { root.runQuickVolume(-1) }
    function muteToggle(): void { root.toggleMute() }
  }

  Component.onCompleted: refreshProbe()

  onOpenedChanged: {
    if (opened) {
      refreshState()
      if (online && !appsLoaded) refreshApps(false)
    }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Process {
    id: probeProc
    command: [root.helperPath, "probe"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseProbe(text)
    }
  }

  Process {
    id: stateProc
    command: [root.helperPath, "state"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseState(text)
    }
  }

  Process {
    id: appsProc
    command: [root.helperPath, "apps"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.parseApps(text)
    }
  }

  Process {
    id: actionProc
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var msg = root.safeText(text, 96)
        if (msg !== "") root.errorMessage = msg
      }
    }
    onExited: function(code) {
      root.busy = false
      if (code === 0) root.errorMessage = ""
      postActionRefresh.restart()
    }
  }

  Process {
    id: volProc
    onExited: postActionRefresh.restart()
  }

  Timer {
    id: postActionRefresh
    interval: 450
    repeat: false
    onTriggered: root.refreshState()
  }

  Timer {
    id: pollTimer
    interval: root.refreshIntervalSec * 1000
    running: !root.opened
    repeat: true
    onTriggered: root.refreshProbe()
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.tvIcon()
    foreground: root.barIconColor
    tooltipText: root.safeText(strings.t("tooltip.bar").arg(root.headerSubtitle()), 120)
    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.toggleScreen()
      else if (b === Qt.RightButton) root.refreshState()
      else root.toggle()
    }

    WheelHandler {
      acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
      onWheel: function(event) {
        var now = Date.now()
        if (now - root.lastWheelMs < 180) return
        root.lastWheelMs = now
        if (event.angleDelta.y > 0) root.runQuickVolume(1)
        else if (event.angleDelta.y < 0) root.runQuickVolume(-1)
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(390))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight)

    content: PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      implicitHeight: Math.min(column.implicitHeight, Style.space(640))
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
          id: column
          width: flick.width
          spacing: Style.space(12)

          // ---------- Header: Icon · Status · Refresh ----------
          RowLayout {
            width: parent.width
            spacing: Style.space(10)

            Text {
              textFormat: Text.PlainText
              text: root.tvIcon()
              color: root.tvLit ? root.foreground : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.display
              Layout.alignment: Qt.AlignVCenter
              Behavior on color { ColorAnimation { duration: Style.duration(180); easing.type: Easing.OutCubic } }
            }

            Column {
              Layout.fillWidth: true
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                text: strings.t("title")
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }

              Text {
                textFormat: Text.PlainText
                text: root.headerSubtitle()
                color: root.pinMismatch ? root.urgent : root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                width: parent.width
              }
            }

            PanelActionButton {
              iconText: "\udb81\udc50"
              tooltipText: strings.t("action.refresh")
              foreground: root.foreground
              fontFamily: root.fontFamily
              enabled: !root.busy
              onClicked: {
                root.refreshState()
                if (root.online) root.refreshApps(true)
              }
            }
          }

          // ---------- Setup Hint (when unconfigured) ----------
          Text {
            visible: !root.configured
            width: parent.width
            textFormat: Text.PlainText
            text: strings.t("setup.hint")
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ---------- Pairing Required Banner ----------
          Button {
            visible: root.configured && root.pairingRequired
            width: parent.width
            bordered: true
            selected: true
            enabled: !root.busy
            iconText: "\udb80\udf3e"
            text: strings.t("action.pair")
            foreground: root.foreground
            fontFamily: root.fontFamily
            onClicked: root.runAction(["tv", "pair"], true)
          }

          // ---------- Error Banner (if any) ----------
          Text {
            visible: root.errorMessage !== ""
            width: parent.width
            textFormat: Text.PlainText
            text: root.errorMessage
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ---------- Power & OLED Screen Off ----------
          RowLayout {
            visible: root.configured
            width: parent.width
            spacing: Style.space(8)

            Button {
              Layout.fillWidth: true
              bordered: true
              selected: root.online
              enabled: !root.busy
              iconText: "\u23fb"
              text: root.online ? strings.t("action.powerOff") : strings.t("action.powerOn")
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.togglePower()
            }

            Button {
              Layout.fillWidth: true
              bordered: true
              selected: root.online && root.screenOff
              enabled: !root.busy && root.online
              iconText: root.screenOff ? "\udb80\udec0" : "\udb80\ude09"
              text: root.screenOff ? strings.t("action.screenOn") : strings.t("action.screenOff")
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.toggleScreen()
            }
          }

          // ---------- Optional Monitor Profiles (hyprmoncfg) ----------
          PanelSeparator { visible: root.hyprmonAvailable; foreground: root.foreground }
          PanelSectionHeader {
            visible: root.hyprmonAvailable
            text: strings.t("section.profiles")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          RowLayout {
            visible: root.hyprmonAvailable
            width: parent.width
            spacing: Style.space(8)

            Button {
              Layout.fillWidth: true
              bordered: true
              selected: root.isProfileActive(root.hyprmonProfileOn)
              enabled: !root.busy
              iconText: "\udb80\udf79"
              text: root.hyprmonProfileOn
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.applyProfile(root.hyprmonProfileOn)
            }

            Button {
              Layout.fillWidth: true
              bordered: true
              selected: root.isProfileActive(root.hyprmonProfileOff)
              enabled: !root.busy
              iconText: "\udb80\udf7a"
              text: root.hyprmonProfileOff
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.applyProfile(root.hyprmonProfileOff)
            }
          }

          // ---------- Audio (TV Volume + Output + PC HDMI Sink) ----------
          PanelSeparator { visible: root.online || root.pcAudioAvailable; foreground: root.foreground }
          PanelSectionHeader {
            visible: root.online || root.pcAudioAvailable
            text: strings.t("section.audio")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(8)
            visible: root.online

            PanelActionButton {
              iconText: root.muted ? "\udb81\udf5f" : "\udb81\udd7e"
              tooltipText: strings.t("audio.muted")
              foreground: root.muted ? root.urgent : root.foreground
              fontFamily: root.fontFamily
              bordered: true
              onClicked: root.toggleMute()
            }

            PanelSlider {
              Layout.fillWidth: true
              bar: root.bar
              minimum: 0
              maximum: 100
              step: 1
              integer: true
              value: root.volume
              onReleased: function(v) { root.setVolume(v) }
              onRightClicked: root.toggleMute()
            }

            Text {
              textFormat: Text.PlainText
              text: root.muted ? strings.t("audio.muted") : Commons.I18n.formatNumber(root.volume) + "%"
              color: root.muted ? root.urgent : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              Layout.preferredWidth: Style.space(46)
              horizontalAlignment: Text.AlignRight
            }
          }

          RowLayout {
            width: parent.width
            spacing: Style.space(6)
            visible: root.online

            Repeater {
              model: [
                { id: "tv_speaker", key: "audio.output.tv_speaker" },
                { id: "external_arc", key: "audio.output.external_arc" },
                { id: "bt_soundbar", key: "audio.output.bt_soundbar" },
                { id: "external_optical", key: "audio.output.external_optical" }
              ]
              delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                bordered: true
                selected: root.soundOutput === modelData.id
                text: strings.t(modelData.key)
                fontSize: Style.font.caption
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.setSoundOutput(modelData.id)
              }
            }
          }

          Button {
            width: parent.width
            visible: root.pcAudioAvailable
            bordered: true
            selected: root.pcAudioOnTv
            iconText: root.pcAudioOnTv ? "\udb81\udd7e" : "\udb80\udecb"
            text: root.pcAudioOnTv ? strings.t("audio.pcOnTv") : strings.t("audio.pcToTv")
            foreground: root.foreground
            fontFamily: root.fontFamily
            leftAlign: true
            onClicked: root.togglePcAudio()
          }

          // ---------- HDMI Inputs ----------
          PanelSeparator { visible: root.online && root.inputs.length > 0; foreground: root.foreground }
          PanelSectionHeader {
            visible: root.online && root.inputs.length > 0
            text: strings.t("section.inputs")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          GridLayout {
            width: parent.width
            visible: root.online && root.inputs.length > 0
            columns: 2
            columnSpacing: Style.space(8)
            rowSpacing: Style.space(6)

            Repeater {
              model: root.inputs
              delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                bordered: true
                selected: root.foregroundAppId === modelData.appId
                enabled: !root.busy
                iconText: modelData.id === root.pcInputId ? "\udb80\udf79" : "\udb80\ude2c"
                text: root.safeText(modelData.label, 22)
                foreground: root.foreground
                fontFamily: root.fontFamily
                leftAlign: true
                onClicked: root.switchInput(modelData.id)
              }
            }
          }

          // ---------- webOS Apps ----------
          PanelSeparator { visible: root.online && root.apps.length > 0; foreground: root.foreground }
          PanelSectionHeader {
            visible: root.online && root.apps.length > 0
            text: strings.t("section.apps")
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          GridLayout {
            width: parent.width
            visible: root.online && root.apps.length > 0
            columns: 2
            columnSpacing: Style.space(8)
            rowSpacing: Style.space(6)

            Repeater {
              model: root.apps
              delegate: Button {
                required property var modelData
                Layout.fillWidth: true
                bordered: true
                selected: root.foregroundAppId === modelData.id
                enabled: !root.busy
                text: root.safeText(modelData.title, 22)
                fontSize: Style.font.caption
                foreground: root.foreground
                fontFamily: root.fontFamily
                leftAlign: true
                onClicked: root.launchApp(modelData.id)
              }
            }
          }

          // ---------- Collapsible Mini Remote & Media ----------
          PanelSeparator { visible: root.online; foreground: root.foreground }

          RowLayout {
            width: parent.width
            visible: root.online

            PanelSectionHeader {
              Layout.fillWidth: true
              text: strings.t("section.remote")
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Button {
              bordered: true
              fontSize: Style.font.caption
              text: root.remoteExpanded ? strings.t("remote.hide") : strings.t("remote.show")
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.remoteExpanded = !root.remoteExpanded
            }
          }

          Column {
            width: parent.width
            visible: root.online && root.remoteExpanded
            spacing: Style.space(8)

            RowLayout {
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: [
                  { cmd: "rewind", icon: "\udb81\udc5f" },
                  { cmd: "play", icon: "\udb81\udc0a" },
                  { cmd: "pause", icon: "\udb80\udfe4" },
                  { cmd: "stop", icon: "\udb81\udcdb" },
                  { cmd: "fastForward", icon: "\udb80\ude11" }
                ]
                delegate: Button {
                  required property var modelData
                  Layout.fillWidth: true
                  bordered: true
                  iconText: modelData.icon
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.sendMedia(modelData.cmd)
                }
              }
            }

            GridLayout {
              anchors.horizontalCenter: parent.horizontalCenter
              columns: 3
              columnSpacing: Style.space(6)
              rowSpacing: Style.space(6)

              Item { Layout.preferredWidth: Style.space(52); Layout.preferredHeight: Style.space(32) }
              Button {
                Layout.preferredWidth: Style.space(52)
                bordered: true
                iconText: "\uf077"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("UP")
              }
              Item { Layout.preferredWidth: Style.space(52); Layout.preferredHeight: Style.space(32) }

              Button {
                Layout.preferredWidth: Style.space(52)
                bordered: true
                iconText: "\uf053"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("LEFT")
              }
              Button {
                Layout.preferredWidth: Style.space(52)
                bordered: true
                selected: true
                text: "OK"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("ENTER")
              }
              Button {
                Layout.preferredWidth: Style.space(52)
                bordered: true
                iconText: "\uf054"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("RIGHT")
              }

              Item { Layout.preferredWidth: Style.space(52); Layout.preferredHeight: Style.space(32) }
              Button {
                Layout.preferredWidth: Style.space(52)
                bordered: true
                iconText: "\uf078"
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("DOWN")
              }
              Item { Layout.preferredWidth: Style.space(52); Layout.preferredHeight: Style.space(32) }
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(6)

              Button {
                Layout.fillWidth: true
                bordered: true
                text: "Back"
                fontSize: Style.font.caption
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("BACK")
              }
              Button {
                Layout.fillWidth: true
                bordered: true
                text: "Home"
                fontSize: Style.font.caption
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("HOME")
              }
              Button {
                Layout.fillWidth: true
                bordered: true
                text: "Exit"
                fontSize: Style.font.caption
                foreground: root.foreground
                fontFamily: root.fontFamily
                onClicked: root.sendKey("EXIT")
              }
            }
          }
        }
      }
    }
  }
}
