#!/usr/bin/env node
// Local LG webOS TV controller for Omarchy (zero external dependencies).
// Uses pinned self-signed TLS (wss://<host>:3001) and UDP Wake-on-LAN.
//
// Commands:
//   setup <ip> [--pc-input HDMI_X] [--mac AA:BB:CC:DD:EE:FF] [--broadcast X.X.X.255]
//                         Probe TLS cert, detect MAC/broadcast, save device.json, and pair.
//   pair                  Request a new client key (accept prompt on the TV).
//   probe                 Fast TLS reachability check (JSON, zero SSAP registration).
//   status                Human-readable reachability probe on the pinned WSS.
//   state                 JSON snapshot: power, screenOff, volume, mute, soundOutput, foregroundApp, inputs.
//   wake                  WOL if needed, wait for WSS, switch to pcInputId (when configured).
//   wake-only             WOL + wait for WSS without switching input.
//   off                   Turn the TV off (standby) over SSAP.
//   screen-off            Turn off panel only (OLED saver / audio-only, keeps HDMI link).
//   screen-on             Turn panel back on.
//   volume <0-100|up|down>
//   mute [on|off|toggle]
//   sound-output [id]     Get or set sound output (tv_speaker, external_arc, bt_soundbar, external_optical).
//   inputs [--json]       List external HDMI inputs.
//   input <id>            Switch to an external input (e.g. HDMI_4).
//   apps                  JSON list of installed launchable webOS apps.
//   launch <appId>        Launch a webOS app by ID.
//   media <play|pause|stop|rewind|fastForward>
//   key <NAME>            Send remote button via pointer socket (UP, DOWN, LEFT, RIGHT, ENTER, BACK, HOME, EXIT...).
//   toast <message...>    Show a toast notification on the TV screen.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

function resolveConfigDir() {
  if (process.env.OMARCHY_LGTV_CONFIG_DIR) {
    return process.env.OMARCHY_LGTV_CONFIG_DIR;
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const primary = path.join(xdg, "omarchy-lgtv");
  const legacy = path.join(xdg, "optimus", "lg-tv");
  if (fs.existsSync(path.join(primary, "device.json"))) return primary;
  if (fs.existsSync(path.join(legacy, "device.json"))) return legacy;
  return primary;
}

const configDir = resolveConfigDir();
const devicePath = path.join(configDir, "device.json");
const keyPath = path.join(configDir, "client-key.json");

let config = {};
let credentials = {};
let host = "";
let port = 3001;
let clientKey = "";
let expectedFingerprint = "";

function loadConfig({ requireKey = true } = {}) {
  if (!fs.existsSync(devicePath)) {
    throw new Error(`Not configured (${devicePath} missing). Run: control.mjs setup <TV_IP>`);
  }
  config = JSON.parse(fs.readFileSync(devicePath, "utf8"));
  host = String(config.host || "");
  port = Number(config.port || 3001);
  expectedFingerprint = String(config.certificateSha256 || "").toLowerCase().replaceAll(":", "");
  if (!host) throw new Error("Missing host in device.json");
  if (!expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error("Invalid TLS certificate pin in device.json");
  }
  if (fs.existsSync(keyPath)) {
    credentials = JSON.parse(fs.readFileSync(keyPath, "utf8"));
    if (credentials.host && credentials.host !== host) {
      throw new Error("Client key belongs to a different configured host");
    }
    clientKey = String(credentials["client-key"] || "");
  } else if (requireKey) {
    throw new Error(`Missing client key (${keyPath}). Run: control.mjs pair`);
  }
}

const MANIFEST_PERMISSIONS = [
  "LAUNCH",
  "LAUNCH_WEBAPP",
  "APP_TO_APP",
  "CLOSE",
  "READ_SETTINGS",
  "READ_NETWORK_STATE",
  "READ_POWER_STATE",
  "READ_INSTALLED_APPS",
  "READ_RUNNING_APPS",
  "READ_COUNTRY_INFO",
  "READ_INPUT_DEVICE_LIST",
  "READ_TV_CHANNEL_LIST",
  "READ_CURRENT_CHANNEL",
  "READ_AUDIO",
  "CONTROL_POWER",
  "CONTROL_TV_SCREEN",
  "CONTROL_TV_STANBY",
  "CONTROL_TV",
  "CONTROL_AUDIO",
  "CONTROL_DISPLAY",
  "CONTROL_INPUT_TV",
  "CONTROL_INPUT_JOYSTICK",
  "CONTROL_INPUT_TEXT",
  "CONTROL_INPUT_MEDIA_PLAYBACK",
  "CONTROL_MOUSE_AND_KEYBOARD",
];
const manifest = () => ({ manifestVersion: 1, appVersion: "1.0", permissions: MANIFEST_PERMISSIONS });

function fetchCertificateFingerprint(targetHost, targetPort = 3001, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let completed = false;
    const finish = (err, val) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(val);
    };
    const socket = tls.connect({ host: targetHost, port: targetPort, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => finish(new Error(`Timed out connecting to ${targetHost}:${targetPort}`)));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      if (!raw) return finish(new Error("TV did not present a TLS certificate"));
      const fp = crypto.createHash("sha256").update(raw).digest("hex");
      finish(null, fp);
    });
    socket.once("error", (err) => finish(err));
  });
}

function tlsProbe(timeoutMs = 1800) {
  return new Promise((resolve) => {
    let completed = false;
    const finish = (result) => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve(result);
    };
    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs, () => finish("offline"));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      const fingerprint = raw ? crypto.createHash("sha256").update(raw).digest("hex") : "";
      finish(fingerprint === expectedFingerprint ? "online" : "pin-mismatch");
    });
    socket.once("error", () => finish("offline"));
  });
}

function sendMagicPacket() {
  const mac = Buffer.from(String(config.mac || "").replaceAll(":", ""), "hex");
  if (mac.length !== 6) throw new Error("Invalid LG MAC address in device.json");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
  const broadcast = String(config.broadcast || "255.255.255.255");
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => { socket.close(); reject(error); });
    socket.bind(0, "0.0.0.0", () => {
      socket.setBroadcast(true);
      socket.send(packet, 9, broadcast, (error, bytes) => {
        socket.close();
        if (error) reject(error);
        else resolve(bytes);
      });
    });
  });
}

function withSession(fn, { useKey = true, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}:${port}`);
    const pending = new Map();
    let seq = 1;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Timed out waiting for LG SSAP")), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const { rej } of pending.values()) {
        try { rej(error || new Error("SSAP session closed")); } catch {}
      }
      pending.clear();
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function request(uri, payload = {}, reqTimeoutMs = 5000) {
      return new Promise((res, rej) => {
        const id = `req_${seq++}`;
        const reqTimer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`Timed out on ${uri}`));
        }, reqTimeoutMs);
        pending.set(id, {
          res: (val) => { clearTimeout(reqTimer); res(val); },
          rej: (err) => { clearTimeout(reqTimer); rej(err); },
        });
        ws.send(JSON.stringify({ id, type: "request", uri, payload }));
      });
    }

    ws.addEventListener("open", () => {
      const reg = { forcePairing: !useKey, pairingType: "PROMPT", manifest: manifest() };
      if (useKey && clientKey) reg["client-key"] = clientKey;
      ws.send(JSON.stringify({ id: "register_0", type: "register", payload: reg }));
    });

    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); }
      catch { return finish(new Error("LG returned a malformed SSAP response")); }

      if (message.type === "error" && message.id === "register_0") {
        return finish(new Error(`LG SSAP registration failed: ${String(message.error || "unknown error").slice(0, 160)}`));
      }
      if (message.type === "response" && message.id === "register_0" && message.payload?.pairingType) {
        if (useKey) {
          return finish(new Error("LG requested pairing prompt; refusing automatic prompt (run `control.mjs pair` manually)"));
        }
        return;
      }
      if (message.type === "registered") {
        Promise.resolve()
          .then(() => fn({ request, registration: message.payload || {} }))
          .then((result) => finish(null, result))
          .catch((err) => finish(err));
        return;
      }
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.type === "error") {
          entry.rej(new Error(`LG rejected request: ${String(message.error || "error")}`));
        } else {
          entry.res(message.payload || {});
        }
      }
    });

    ws.addEventListener("error", () => finish(new Error("Pinned WSS connection to LG failed")));
  });
}

function ssap(uri, payload = {}, { useKey = true, timeoutMs = 15000 } = {}) {
  return withSession(async ({ request, registration }) => {
    if (uri === null) return registration;
    return request(uri, payload, timeoutMs);
  }, { useKey, timeoutMs });
}

function detectMacAndBroadcast(targetIp) {
  let mac = "";
  let broadcast = "";
  try {
    const neigh = execFileSync("ip", ["neigh", "show", targetIp], { encoding: "utf8" });
    const m = neigh.match(/lladdr\s+([0-9a-f:]{17})/i);
    if (m) mac = m[1].toLowerCase();
  } catch {}
  try {
    const route = execFileSync("ip", ["-4", "route", "get", targetIp], { encoding: "utf8" });
    const devMatch = route.match(/\bdev\s+(\S+)/);
    if (devMatch) {
      const addr = execFileSync("ip", ["-4", "addr", "show", "dev", devMatch[1]], { encoding: "utf8" });
      const brdMatch = addr.match(/\bbrd\s+(\d+\.\d+\.\d+\.\d+)/);
      if (brdMatch) broadcast = brdMatch[1];
    }
  } catch {}
  return { mac, broadcast: broadcast || "255.255.255.255" };
}

async function setup(args) {
  const targetIp = args[0];
  if (!targetIp || !/^\d{1,3}(\.\d{1,3}){3}$/.test(targetIp)) {
    throw new Error("Usage: control.mjs setup <TV_IP> [--pc-input HDMI_X] [--mac AA:BB:CC:DD:EE:FF] [--broadcast X.X.X.255]");
  }

  let pcInputId = "";
  let macArg = "";
  let broadcastArg = "";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--pc-input" && args[i + 1]) pcInputId = args[++i];
    else if (args[i] === "--mac" && args[i + 1]) macArg = args[++i];
    else if (args[i] === "--broadcast" && args[i + 1]) broadcastArg = args[++i];
  }

  console.log(`Connecting to LG webOS TV at ${targetIp}:3001...`);
  const fingerprint = await fetchCertificateFingerprint(targetIp, 3001, 4000);
  const detected = detectMacAndBroadcast(targetIp);
  const finalMac = (macArg || detected.mac).toLowerCase();
  const finalBroadcast = broadcastArg || detected.broadcast;

  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const deviceData = {
    host: targetIp,
    port: 3001,
    mac: finalMac,
    broadcast: finalBroadcast,
    certificateSha256: fingerprint,
    pcInputId,
  };
  fs.writeFileSync(devicePath, JSON.stringify(deviceData, null, 2) + "\n", { mode: 0o600 });
  console.log(`Saved ${devicePath}`);
  console.log(`  TLS SHA-256: ${fingerprint}`);
  console.log(`  MAC:         ${finalMac || "(not detected — set manually in device.json for Wake-on-LAN)"}`);
  console.log(`  Broadcast:   ${finalBroadcast}`);

  loadConfig({ requireKey: false });
  await pair();
}

async function ensurePcInput() {
  const target = process.env.LG_TV_PC_INPUT || config.pcInputId;
  if (!target) {
    console.log("No PC input configured (device.json pcInputId); skipping input switch.");
    return;
  }
  await ssap("ssap://tv/switchInput", { inputId: String(target) });
  console.log(`LG switched to input ${target}.`);
}

async function wake({ switchToPc = true } = {}) {
  let state = await tlsProbe();
  if (state === "pin-mismatch") throw new Error("LG TLS certificate changed; refusing to trust a different device");

  if (state === "online") {
    try { await sendMagicPacket(); } catch (error) { console.log(`WOL send failed: ${error.message}`); }
    console.log("LG reachable over pinned WSS; wake packet sent.");
    try { await ssap("ssap://com.webos.service.tvpower/power/turnOnScreen", {}, { timeoutMs: 4000 }); } catch {}
  } else {
    const retryWindowMs = Math.max(0, Number(process.env.LG_TV_WOL_RETRY_MS || 15000));
    const sendDeadline = Date.now() + retryWindowMs;
    let sent = 0;
    let networkRetries = 0;
    while (sent < 3) {
      try {
        const bytes = await sendMagicPacket();
        sent++;
        console.log(`WOL ${sent}/3 sent (${bytes} bytes, UDP/9).`);
        if (sent < 3) await delay(1000);
      } catch (error) {
        const networkDown = ["ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "ENETRESET"].includes(error.code);
        if (!networkDown || Date.now() >= sendDeadline) throw error;
        networkRetries++;
        if (networkRetries === 1 || networkRetries % 5 === 0)
          console.log(`LAN not ready (${error.code}); retrying WOL send.`);
        await delay(1000);
      }
    }

    const wakeTimeoutMs = Math.max(5000, Number(process.env.LG_TV_WAKE_TIMEOUT_MS || 35000));
    const deadline = Date.now() + wakeTimeoutMs;
    for (;;) {
      if (Date.now() >= deadline)
        throw new Error(`WOL was sent, but the LG did not return on pinned WSS within ${Math.round(wakeTimeoutMs / 1000)} seconds`);
      state = await tlsProbe();
      if (state === "pin-mismatch") throw new Error("A different TLS device answered at the LG address; stopping");
      if (state === "online") { console.log("LG awake; pinned WSS endpoint is reachable."); break; }
      await delay(1000);
    }
  }

  if (switchToPc) await ensurePcInput();
}

async function turnOff() {
  const state = await tlsProbe();
  if (state === "pin-mismatch") throw new Error("LG TLS certificate changed; refusing to control a different device");
  if (state === "offline") {
    console.log("LG SSAP is unreachable; treating it as already in standby.");
    return;
  }
  if (!clientKey) throw new Error("Missing webOS client key");
  await ssap("ssap://system/turnOff", {});
  console.log("LG accepted the power-off command.");
}

async function getState() {
  const probe = await tlsProbe(1600);
  if (probe === "pin-mismatch") {
    console.log(JSON.stringify({
      configured: true,
      online: false,
      reachable: false,
      pinMismatch: true,
      pairingRequired: false,
      powerState: "Pin Mismatch",
      screenOff: false,
      pcInputId: config.pcInputId || "",
    }));
    return;
  }
  if (probe !== "online") {
    console.log(JSON.stringify({
      configured: true,
      online: false,
      reachable: false,
      pinMismatch: false,
      pairingRequired: false,
      powerState: "Standby",
      screenOff: false,
      volume: 0,
      muted: false,
      soundOutput: "",
      foregroundAppId: "",
      inputs: [],
      pcInputId: config.pcInputId || "",
    }));
    return;
  }

  let snapshot;
  try {
    snapshot = await withSession(async ({ request }) => {
      const safe = async (uri, payload = {}) => {
        try { return await request(uri, payload, 3500); }
        catch { return null; }
      };

      const [power, vol, sound, fg, ext] = await Promise.all([
        safe("ssap://com.webos.service.tvpower/power/getPowerState"),
        safe("ssap://audio/getVolume"),
        safe("ssap://audio/getSoundOutput"),
        safe("ssap://com.webos.applicationManager/getForegroundAppInfo"),
        safe("ssap://tv/getExternalInputList"),
      ]);

      const powerState = String(power?.state || "Active");
      const screenOff = /screen\s*off/i.test(powerState);
      const activeStandby = /standby/i.test(powerState);
      const volNum = typeof vol?.volume === "number"
        ? vol.volume
        : (typeof vol?.volumeStatus?.volume === "number" ? vol.volumeStatus.volume : 0);
      const muted = Boolean(vol?.muted ?? vol?.volumeStatus?.muteStatus ?? false);
      const soundOutput = String(sound?.soundOutput || vol?.volumeStatus?.soundOutput || "");
      const foregroundAppId = String(fg?.appId || "");
      const rawDevices = Array.isArray(ext?.devices) ? ext.devices : [];
      const inputs = rawDevices.slice(0, 12).map((d) => ({
        id: String(d.id || ""),
        label: String(d.label || d.id || "").slice(0, 48),
        appId: String(d.appId || ""),
        connected: Boolean(d.connected),
      }));

      return {
        configured: true,
        online: !activeStandby,
        reachable: true,
        pinMismatch: false,
        pairingRequired: false,
        powerState,
        screenOff,
        volume: Math.max(0, Math.min(100, Math.round(volNum))),
        muted,
        soundOutput,
        foregroundAppId,
        inputs,
        pcInputId: String(config.pcInputId || ""),
      };
    }, { timeoutMs: 8000 });
  } catch (err) {
    const needsPair = /pairing/i.test(String(err?.message || ""));
    snapshot = {
      configured: true,
      online: false,
      reachable: true,
      pinMismatch: false,
      pairingRequired: needsPair,
      powerState: needsPair ? "Pairing Required" : "Standby",
      screenOff: false,
      volume: 0,
      muted: false,
      soundOutput: "",
      foregroundAppId: "",
      inputs: [],
      pcInputId: String(config.pcInputId || ""),
    };
  }

  console.log(JSON.stringify(snapshot));
}

async function listInputs(asJson = false) {
  const payload = await ssap("ssap://tv/getExternalInputList");
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  if (asJson) {
    console.log(JSON.stringify(devices.map((d) => ({
      id: String(d.id || ""),
      label: String(d.label || d.id || ""),
      appId: String(d.appId || ""),
      connected: Boolean(d.connected),
    }))));
    return;
  }
  if (devices.length === 0) {
    console.log("No external inputs reported.");
    return;
  }
  for (const device of devices) {
    const label = device.label || device.appId || "";
    const connected = device.connected === true ? "connected" : "";
    console.log(`${device.id}\t${label}\t${connected}`);
  }
}

async function switchInput(id) {
  if (!id) throw new Error("Usage: control.mjs input <inputId> (see `control.mjs inputs`)");
  await ssap("ssap://tv/switchInput", { inputId: String(id) });
  console.log(`LG switched to input ${id}.`);
}

async function setScreen(on) {
  const uri = on
    ? "ssap://com.webos.service.tvpower/power/turnOnScreen"
    : "ssap://com.webos.service.tvpower/power/turnOffScreen";
  await ssap(uri, { standbyMode: "active" });
  console.log(on ? "LG screen turned ON." : "LG screen turned OFF.");
}

async function handleVolume(arg) {
  if (!arg) throw new Error("Usage: control.mjs volume <0-100|up|down>");
  if (arg === "up") {
    await ssap("ssap://audio/volumeUp");
    console.log("LG volume up.");
    return;
  }
  if (arg === "down") {
    await ssap("ssap://audio/volumeDown");
    console.log("LG volume down.");
    return;
  }
  const level = Number(arg);
  if (!Number.isFinite(level) || level < 0 || level > 100) {
    throw new Error("Volume must be 0-100, up, or down");
  }
  await ssap("ssap://audio/setVolume", { volume: Math.round(level) });
  console.log(`LG volume set to ${Math.round(level)}.`);
}

async function handleMute(arg = "toggle") {
  if (arg === "on" || arg === "true") {
    await ssap("ssap://audio/setMute", { mute: true });
    console.log("LG muted.");
    return;
  }
  if (arg === "off" || arg === "false") {
    await ssap("ssap://audio/setMute", { mute: false });
    console.log("LG unmuted.");
    return;
  }
  await withSession(async ({ request }) => {
    const vol = await request("ssap://audio/getVolume");
    const currentlyMuted = Boolean(vol?.muted ?? vol?.volumeStatus?.muteStatus ?? false);
    await request("ssap://audio/setMute", { mute: !currentlyMuted });
    console.log(!currentlyMuted ? "LG muted." : "LG unmuted.");
  });
}

async function handleSoundOutput(outputId) {
  if (!outputId) {
    const res = await ssap("ssap://audio/getSoundOutput");
    console.log(JSON.stringify({ soundOutput: String(res?.soundOutput || "") }));
    return;
  }
  await ssap("ssap://audio/changeSoundOutput", { output: String(outputId) });
  console.log(`LG sound output set to ${outputId}.`);
}

async function listApps() {
  const payload = await ssap("ssap://com.webos.applicationManager/listLaunchPoints");
  const points = Array.isArray(payload.launchPoints) ? payload.launchPoints : [];
  const apps = points
    .filter((p) => p && p.id && p.title && p.systemApp !== true && !String(p.id).startsWith("com.webos.app.hdmi"))
    .map((p) => ({
      id: String(p.id),
      title: String(p.title).slice(0, 48),
    }))
    .sort((a, b) => a.title.localeCompare(b.title));
  console.log(JSON.stringify(apps));
}

async function launchApp(appId) {
  if (!appId) throw new Error("Usage: control.mjs launch <appId>");
  await ssap("ssap://system.launcher/launch", { id: String(appId) });
  console.log(`LG launched ${appId}.`);
}

async function handleMedia(cmd) {
  const allowed = new Set(["play", "pause", "stop", "rewind", "fastForward"]);
  if (!allowed.has(cmd)) throw new Error("Usage: control.mjs media <play|pause|stop|rewind|fastForward>");
  await ssap(`ssap://media.controls/${cmd}`);
  console.log(`LG media ${cmd}.`);
}

async function sendKey(rawKey) {
  const key = String(rawKey || "").toUpperCase();
  const allowed = new Set([
    "UP", "DOWN", "LEFT", "RIGHT", "ENTER", "BACK", "HOME", "EXIT",
    "MENU", "INFO", "MUTE", "VOLUMEUP", "VOLUMEDOWN", "CHANNELUP",
    "CHANNELDOWN", "PLAY", "PAUSE", "STOP", "REWIND", "FASTFORWARD",
    "DASH", "RED", "GREEN", "YELLOW", "BLUE",
  ]);
  if (!allowed.has(key)) throw new Error(`Unsupported key: ${key}`);

  const res = await ssap("ssap://com.webos.service.networkinput/getPointerInputSocket");
  const socketPath = String(res?.socketPath || "");
  if (!socketPath.startsWith("ws://") && !socketPath.startsWith("wss://")) {
    throw new Error("LG did not return a valid pointer input socket");
  }

  await new Promise((resolve, reject) => {
    const pws = new WebSocket(socketPath);
    let done = false;
    const timer = setTimeout(() => finish(new Error("Pointer socket timed out")), 4000);
    function finish(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pws.close(); } catch {}
      if (err) reject(err);
      else resolve();
    }
    pws.addEventListener("open", () => {
      pws.send(`type:button\nname:${key}\n\n`);
      setTimeout(() => finish(null), 120);
    });
    pws.addEventListener("error", () => finish(new Error("Pointer socket error")));
  });
  console.log(`LG key ${key} sent.`);
}

async function sendToast(message) {
  const text = String(message || "").trim().slice(0, 140);
  if (!text) throw new Error("Usage: control.mjs toast <message>");
  await ssap("ssap://system.notifications/createToast", { message: text }, { timeoutMs: 3000 });
  console.log("LG toast sent.");
}

async function pair() {
  console.log("Requesting a client key with full control permissions. Accept the prompt on the TV.");
  const payload = await ssap(null, {}, { useKey: false, timeoutMs: 60000 });
  const newKey = String(payload["client-key"] || "");
  if (!newKey) throw new Error("The TV did not return a client key; was the prompt accepted?");
  if (fs.existsSync(keyPath)) {
    const backup = `${keyPath}.bak.${Math.floor(Date.now() / 1000)}`;
    fs.copyFileSync(keyPath, backup);
  }
  fs.writeFileSync(keyPath, JSON.stringify({ host, "client-key": newKey }, null, 2) + "\n", { mode: 0o600 });
  console.log(`New client key stored in ${keyPath}.`);
}

async function main() {
  const action = process.argv[2];
  if (action === "setup") return setup(process.argv.slice(3));

  if (action === "probe") {
    if (!fs.existsSync(devicePath)) {
      console.log(JSON.stringify({ configured: false, reachable: false, pinMismatch: false }));
      return;
    }
    loadConfig({ requireKey: false });
    const state = await tlsProbe(1500);
    console.log(JSON.stringify({
      configured: true,
      reachable: state === "online",
      pinMismatch: state === "pin-mismatch",
    }));
    return;
  }

  if (action === "pair") {
    loadConfig({ requireKey: false });
    return pair();
  }

  if (action === "state" && !fs.existsSync(devicePath)) {
    console.log(JSON.stringify({
      configured: false,
      online: false,
      reachable: false,
      pinMismatch: false,
      pairingRequired: false,
      powerState: "Not Configured",
      screenOff: false,
      volume: 0,
      muted: false,
      soundOutput: "",
      foregroundAppId: "",
      inputs: [],
      pcInputId: "",
    }));
    return;
  }

  loadConfig({ requireKey: action !== "status" });

  if (action === "wake") return wake({ switchToPc: true });
  if (action === "wake-only") return wake({ switchToPc: false });
  if (action === "off") return turnOff();
  if (action === "state") return getState();
  if (action === "screen-off") return setScreen(false);
  if (action === "screen-on") return setScreen(true);
  if (action === "volume") return handleVolume(process.argv[3]);
  if (action === "mute") return handleMute(process.argv[3]);
  if (action === "sound-output") return handleSoundOutput(process.argv[3]);
  if (action === "inputs") return listInputs(process.argv.includes("--json"));
  if (action === "input") return switchInput(process.argv[3]);
  if (action === "apps") return listApps();
  if (action === "launch") return launchApp(process.argv[3]);
  if (action === "media") return handleMedia(process.argv[3]);
  if (action === "key") return sendKey(process.argv[3]);
  if (action === "toast") return sendToast(process.argv.slice(3).join(" "));
  if (action === "status") {
    const state = await tlsProbe();
    if (state === "pin-mismatch") throw new Error("TLS certificate pin mismatch");
    console.log(state === "online" ? "LG reachable (certificate pin verified)." : "LG not reachable on pinned WSS.");
    if (state !== "online") process.exitCode = 1;
    return;
  }
  throw new Error("Usage: control.mjs {setup <ip>|pair|probe|status|state|wake|wake-only|off|screen-off|screen-on|volume|mute|sound-output|inputs|input|apps|launch|media|key|toast}");
}

main().catch((error) => {
  console.error(`LG TV control failed: ${error.message}`);
  process.exitCode = 1;
});
