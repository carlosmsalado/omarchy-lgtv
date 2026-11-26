import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const modelCode = fs.readFileSync(path.join(rootDir, "Model.js"), "utf8");
const modelCtx = {};
vm.createContext(modelCtx);
vm.runInContext(modelCode, modelCtx);

test("safeText neutralizes HTML/QML markup and bounds length", () => {
  const tracker = '<img src="https://example.invalid/tracker">YouTube';
  const cleaned = modelCtx.safeText(tracker, 48);
  assert.equal(cleaned.includes("<"), false);
  assert.equal(cleaned.includes(">"), false);

  const entity = "A & B <script>alert(1)</script>";
  const cleanedEntity = modelCtx.safeText(entity, 64);
  assert.equal(cleanedEntity.includes("<"), false);
  assert.equal(cleanedEntity.includes(">"), false);
  assert.equal(cleanedEntity.includes("&"), false);

  const long = "A".repeat(100);
  const truncated = modelCtx.safeText(long, 20);
  assert.equal(truncated.length, 20);
  assert.equal(truncated.endsWith("…"), true);
});

test("isValidIpv4 and isValidHdmiInput validate setup inputs strictly", () => {
  assert.equal(modelCtx.isValidIpv4("192.168.4.30"), true);
  assert.equal(modelCtx.isValidIpv4("10.0.0.1"), true);
  assert.equal(modelCtx.isValidIpv4("256.0.0.1"), false);
  assert.equal(modelCtx.isValidIpv4("192.168.1.1; rm -rf /"), false);
  assert.equal(modelCtx.isValidIpv4(""), false);

  assert.equal(modelCtx.isValidHdmiInput(""), true);
  assert.equal(modelCtx.isValidHdmiInput("HDMI_4"), true);
  assert.equal(modelCtx.isValidHdmiInput("HDMI_1; whoami"), false);
});

test("parseStatePayload clamps volume, bounds inputs, and neutralizes markup", () => {
  const raw = JSON.stringify({
    configured: true,
    online: true,
    reachable: true,
    volume: 145,
    muted: false,
    soundOutput: "<b>tv_speaker</b>",
    foregroundAppId: "com.webos.app.hdmi4",
    inputs: Array.from({ length: 20 }, (_, i) => ({
      id: `HDMI_${i + 1}`,
      label: `<img src=x>Input ${i + 1}`,
      appId: `com.webos.app.hdmi${i + 1}`,
      connected: true,
    })),
  });
  const parsed = modelCtx.parseStatePayload(raw);
  assert.equal(parsed.volume, 100);
  assert.equal(parsed.inputs.length, 12);
  assert.equal(parsed.inputs[0].label.includes("<"), false);
  assert.equal(parsed.soundOutput.includes("<"), false);
});

test("parseAppsPayload bounds list and strips markup from titles", () => {
  const raw = JSON.stringify(
    Array.from({ length: 40 }, (_, i) => ({
      id: `app.${i}`,
      title: `<b>App ${i}</b>`,
    })),
  );
  const apps = modelCtx.parseAppsPayload(raw);
  assert.equal(apps.length, 24);
  assert.equal(apps[0].title.includes("<"), false);
});

test("i18n catalogs en.json and es.json have identical keys", () => {
  const en = JSON.parse(fs.readFileSync(path.join(rootDir, "i18n/en.json"), "utf8"));
  const es = JSON.parse(fs.readFileSync(path.join(rootDir, "i18n/es.json"), "utf8"));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort());
});

test("Panel.qml sets textFormat: Text.PlainText on every Text element", () => {
  const qml = fs.readFileSync(path.join(rootDir, "Panel.qml"), "utf8");
  const blocks = qml.split(/\bText\s*\{/).slice(1);
  assert.ok(blocks.length >= 5, "Expected Text elements in Panel.qml");
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf("}"));
    assert.ok(
      body.includes("textFormat: Text.PlainText"),
      `Missing textFormat: Text.PlainText in Text block:\n${body.slice(0, 120)}`,
    );
  }
});

test("lgtv-helper.sh rejects unsafe profile names", () => {
  assert.throws(() => {
    execFileSync(path.join(rootDir, "lgtv-helper.sh"), ["profile", "../etc/passwd"], {
      stdio: "pipe",
    });
  });
  assert.throws(() => {
    execFileSync(path.join(rootDir, "lgtv-helper.sh"), ["profile", "3 pantallas; id"], {
      stdio: "pipe",
    });
  });
});
