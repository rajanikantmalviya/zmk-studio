import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const output = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(
        new URL("../src/behaviors/virtualKeys.ts", import.meta.url),
      ),
      formats: ["es"],
    },
  },
});
const chunk = output[0].output.find((item) => item.type === "chunk");
const {
  virtualKeyboards,
  isUsageAllowed,
  withImplicitModifiers,
  isSimpleKeyPress,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

test("keyboard palette uses correct HID codes and unique key usages", () => {
  const keys = Object.values(virtualKeyboards).flat(2);
  assert.equal(new Set(keys.map((key) => key.usage)).size, keys.length);
  for (const [label, usage] of [
    ["A", 0x70004],
    ["Z", 0x7001d],
    ["1", 0x7001e],
    ["F12", 0x70045],
    ["R GUI", 0x700e7],
    ["Num Enter", 0x70058],
    ["Mute", 0xc00e2],
  ]) {
    assert.equal(keys.find((key) => key.label === label).usage, usage);
  }
});

test("firmware limits disable unsupported keys while allowing keyboard modifiers", () => {
  const pages = [
    { id: 7, min: 4, max: 100 },
    { id: 12, max: 255 },
  ];
  assert.equal(isUsageAllowed(0x70004, pages), true);
  assert.equal(isUsageAllowed(0x700e7, pages), true);
  assert.equal(isUsageAllowed(0x70065, pages), false);
  assert.equal(isUsageAllowed(0xc0224, pages), false);
  assert.equal(isUsageAllowed(0xc00e2, [{ id: 7 }]), false);
  assert.equal(isUsageAllowed(0x70004, [{ id: 12 }]), false);
  assert.equal(isUsageAllowed(0x70001, pages), false);
  assert.equal(isUsageAllowed(0xc0224, [{ id: 12, max: 0 }]), true);
});

test("modifier combinations preserve HID usages as unsigned 32-bit values", () => {
  assert.equal(withImplicitModifiers(0x70006, 1), 0x01070006);
  assert.equal(withImplicitModifiers(0x70006, 128), 0x80070006);
  assert.equal(withImplicitModifiers(0x80070006, 0), 0x70006);
  assert.equal(withImplicitModifiers(0x80070006, 255), 0xff070006);
  assert.equal(withImplicitModifiers(0xc00e2, 128), 0x800c00e2);
});

test("auto-selection accepts key presses but not hold-tap or layer behaviors", () => {
  const keyPress = {
    id: 1,
    displayName: "Key Press",
    metadata: [
      {
        param1: [{ hidUsage: { keyboardMax: 231, consumerMax: 767 } }],
        param2: [],
      },
    ],
  };
  assert.equal(isSimpleKeyPress(keyPress), true);
  assert.equal(isSimpleKeyPress({ ...keyPress, metadata: [] }), false);
  assert.equal(
    isSimpleKeyPress({
      ...keyPress,
      metadata: [{ param1: [{ layerId: {} }], param2: [] }],
    }),
    false,
  );
  assert.equal(
    isSimpleKeyPress({
      ...keyPress,
      metadata: [
        { param1: keyPress.metadata[0].param1, param2: [{ layerId: {} }] },
      ],
    }),
    false,
  );
});
