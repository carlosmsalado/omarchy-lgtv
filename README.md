# omarchy-lgtv

Native [Omarchy](https://omarchy.org/) shell bar plugin to control an **LG webOS TV** directly from your Linux desktop — zero external Node/Python dependencies, pinned TLS certificate verification, Wake-on-LAN, OLED screen-off, PipeWire HDMI audio switching, and optional `hyprmoncfg` monitor profile integration.

## Features

- **Power & OLED Screen-Off**:
  - Turn On via UDP Wake-on-LAN (`wake-only` or `wake` with auto PC HDMI input switch).
  - Turn Off (standby) over local webOS SSAP.
  - **Screen Off / On** (`turnOffScreen` / `turnOnScreen`): turns off only the panel (ideal for OLED burn-in protection or audio-only playback) without dropping the HDMI link.
- **TV Volume & Audio**:
  - Live volume slider (0–100) + Mute toggle + scroll wheel over the bar icon.
  - Quick TV sound output selector (`TV`, `HDMI ARC`, `Bluetooth`, `Optical`).
  - One-click **PipeWire PC Audio ↔ TV HDMI** sink toggle (automatically detects `[LG TV]` sink and restores your previous desktop sink).
- **HDMI Inputs & webOS Apps**:
  - Lists and switches external HDMI inputs with active highlight.
  - Lists installed webOS apps (YouTube, Jellyfin, Plex, Netflix, etc.) and launches them in one click.
- **Collapsible Mini Remote & Media Controls**:
  - Rewind, Play, Pause, Stop, Fast Forward.
  - Compact D-Pad (`Up`, `Down`, `Left`, `Right`, `OK`, `Back`, `Home`, `Exit`) via webOS pointer socket.
- **Optional `hyprmoncfg` Integration**:
  - Automatically detected if `~/.config/hyprmoncfg/apply-profile.sh` is present; hidden otherwise.
- **Silent & Safe by Design**:
  - Background bar polling uses a **TLS-only reachability probe** (cached 10s, serialized with `flock`) — zero SSAP registrations in the background, zero pairing popups on the TV.
  - Refuses automatic pairing prompts during normal commands; explicit pairing button included in the panel.
  - Local LAN only, pinned SHA-256 TLS certificate, `Text.PlainText` throughout QML, live `en` / `es` i18n.

## Requirements

- Omarchy with `omarchy-shell` (Quickshell)
- `node` (>= 20, built-in `WebSocket`)
- `jq`, `flock` (`util-linux`), `ip` (`iproute2`)
- Optional: `wpctl` (PipeWire/WirePlumber) for PC HDMI audio toggle
- On your LG TV: enable **LG Connect Apps** and **Turn On via Wi-Fi / Mobile TV On** (Settings → General → External Devices / Network)

## Installation

Install directly from GitHub using Omarchy's plugin manager:

```bash
omarchy plugin add https://github.com/carlosmsalado/omarchy-lgtv --enable
```

## First-Time TV Setup (TLS Pin + Pairing)

Turn your LG TV on and run once from a terminal:

```bash
node ~/.config/omarchy/plugins/carlosmsalado.lgtv/bin/control.mjs setup <TV_IP> --pc-input HDMI_4
```

This will:
1. Connect to `wss://<TV_IP>:3001` and pin the TV's SHA-256 TLS certificate.
2. Detect the TV's MAC address and LAN broadcast for Wake-on-LAN.
3. Save `~/.config/omarchy-lgtv/device.json` (`0600`).
4. Trigger a single pairing prompt on the TV — accept it to store `~/.config/omarchy-lgtv/client-key.json` (`0600`).

> Config directory lookup order: `$OMARCHY_LGTV_CONFIG_DIR` → `~/.config/omarchy-lgtv/` → `~/.config/optimus/lg-tv/`.

## Bar Interactions

- **Left click**: open / close the LG TV control panel.
- **Middle click**: quick toggle **Screen Off / On** (or wake if in standby).
- **Scroll wheel**: TV volume up / down.
- **Right click**: force refresh state.

## IPC & Hyprland Keybinds

The plugin exposes `ShellIpc` on `carlosmsalado.lgtv`:

```bash
omarchy-shell carlosmsalado.lgtv toggle
omarchy-shell carlosmsalado.lgtv powerToggle
omarchy-shell carlosmsalado.lgtv screenToggle
omarchy-shell carlosmsalado.lgtv volumeUp
omarchy-shell carlosmsalado.lgtv volumeDown
omarchy-shell carlosmsalado.lgtv muteToggle
```

## License

MIT — see [LICENSE](LICENSE).
