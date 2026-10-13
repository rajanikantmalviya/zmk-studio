import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const result = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("../src/viewer/model.ts", import.meta.url)),
      formats: ["es"],
    },
  },
});
const chunk = result[0].output.find((item) => item.type === "chunk");
const {
  parseConfiguration,
  parseSnapshot,
  bindingLabel,
  displayedKeys,
  keyValue,
  viewerBounds,
  viewerOverlaySize,
  viewerShortcuts,
  viewerShortcutEdges,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

const frames = () => [
  {
    type: "hello",
    version: 1,
    deviceName: "Chocofi",
    layoutName: "5 Column",
    defaultLayer: 0,
  },
  ...[0, 1, 2].map((position) => ({
    type: "key",
    position,
    x: position * 100,
    y: 0,
    width: 100,
    height: 100,
    r: 0,
    rx: position * 100,
    ry: 0,
  })),
  { type: "behavior", id: 1, name: "Key Press", kind: "key", children: [] },
  {
    type: "behavior",
    id: 2,
    name: "Home Row Mods Left",
    kind: "hold-tap",
    children: [
      [1, 0, 0],
      [1, 0, 0],
    ],
  },
  {
    type: "behavior",
    id: 3,
    name: "Layer-Tap",
    kind: "hold-tap",
    children: [
      [4, 0, 0],
      [1, 0, 0],
    ],
  },
  {
    type: "behavior",
    id: 4,
    name: "Momentary Layer",
    kind: "momentary-layer",
    children: [],
  },
  {
    type: "behavior",
    id: 5,
    name: "Transparent",
    kind: "transparent",
    children: [],
  },
  {
    type: "behavior",
    id: 6,
    name: "Sticky Layer",
    kind: "sticky",
    children: [[4, 0, 0]],
  },
  {
    type: "behavior",
    id: 7,
    name: "One Shot Function",
    kind: "tap-dance",
    children: [[6, 9, 0]],
  },
  {
    type: "layer",
    id: 0,
    name: "Base",
    bindings: [
      [2, 0x700e1, 0x70004],
      [3, 9, 0x7002c],
      [1, 0x70005, 0],
    ],
  },
  {
    type: "layer",
    id: 9,
    name: "Nav",
    bindings: [
      [1, 0x70050, 0],
      [1, 0x70028, 0],
      [5, 0, 0],
    ],
  },
  {
    type: "combo",
    name: "example",
    positions: [0, 2],
    layers: [0],
    binding: [7, 0, 0],
    timeoutMs: 80,
  },
  { type: "ready" },
];
const state = (changes = {}) => ({
  type: "state",
  sequence: 1,
  pressed: [],
  released: [],
  layers: [0],
  ...changes,
});

test("tap values and HRM hold values are separate and compact", () => {
  const config = parseConfiguration(frames());
  assert.deepEqual(bindingLabel(config, [2, 0x700e1, 0x70004]), {
    tap: "A",
    hold: "Lshft",
  });
  assert.deepEqual(bindingLabel(config, [2, 0x700e4, 0x7000f]), {
    tap: "L",
    hold: "Rctrl",
  });
  assert.deepEqual(bindingLabel(config, [3, 9, 0x7002c]), {
    tap: "Space",
    hold: "Nav",
  });
  assert.equal(keyValue(0x01070006), "Lctrl+C");
  assert.equal(keyValue(0x7002f), "[");
  assert.equal(keyValue(0x70030), "]");
  assert.equal(keyValue(0x70016), "S");
});

test("actual active layer changes preserve the binding of the held layer-tap", () => {
  const config = parseConfiguration(frames());
  const snapshot = parseSnapshot(
    state({ pressed: [[1, 0]], layers: [9, 0] }),
    config,
  );
  const keys = displayedKeys(config, snapshot);
  assert.equal(keys[0].tap, keyValue(0x70050));
  assert.equal(keys[1].tap, "Space");
  assert.equal(keys[1].hold, "Nav");
  assert.equal(keys[1].pressed, true);
  assert.equal(keys[2].tap, "B");
  const released = displayedKeys(
    config,
    parseSnapshot(state({ released: [1] }), config),
  );
  assert.equal(released[0].tap, "A");
  assert.equal(released[1].pressed, false);
});

test("held HRM stays at its physical position rather than matching Windows output", () => {
  const config = parseConfiguration(frames());
  const keys = displayedKeys(
    config,
    parseSnapshot(state({ pressed: [[0, 0]], layers: [9, 0] }), config),
  );
  assert.equal(keys[0].tap, "A");
  assert.equal(keys[0].hold, "Lshft");
  assert.equal(keys[0].pressed, true);
  assert.equal(keys[1].pressed, false);
});

test("firmware combo and one-shot action definitions are retained", () => {
  const config = parseConfiguration(frames());
  assert.deepEqual(config.combos[0].positions, [0, 2]);
  assert.deepEqual(config.combos[0].layers, [0]);
  assert.equal(config.combos[0].timeoutMs, 80);
  assert.equal(bindingLabel(config, config.combos[0].binding).tap, "Once Nav");
  assert.equal(config.keys[1].x, 1);
  assert.equal(viewerBounds(config).length, 4);
});

test("invalid, incomplete, or incompatible firmware data is rejected explicitly", () => {
  assert.throws(() => parseConfiguration(frames().slice(0, -1)), /Incomplete/);
  const version = frames();
  version[0].version = 2;
  assert.throws(() => parseConfiguration(version), /version/);
  const missing = frames().filter(
    (frame) => !(frame.type === "behavior" && frame.id === 1),
  );
  assert.throws(() => parseConfiguration(missing), /Unknown firmware behavior/);
  const duplicate = frames();
  duplicate.push(duplicate.find((frame) => frame.type === "layer"));
  assert.throws(() => parseConfiguration(duplicate), /Inconsistent/);
  const geometry = frames();
  geometry.find((frame) => frame.type === "key").width = -100;
  assert.throws(() => parseConfiguration(geometry), /size/);
  const badCombo = frames();
  badCombo.find((frame) => frame.type === "combo").positions = [50];
  assert.throws(() => parseConfiguration(badCombo), /combo/);
});

test("invalid physical positions and stale layer IDs cannot drive the display", () => {
  const config = parseConfiguration(frames());
  assert.throws(
    () => parseSnapshot(state({ pressed: [[30, 0]] }), config),
    /integer/,
  );
  assert.throws(
    () => parseSnapshot(state({ pressed: [[0, 8]] }), config),
    /layer/,
  );
  assert.throws(
    () => parseSnapshot(state({ layers: [] }), config),
    /active layers/,
  );
  assert.throws(
    () => parseSnapshot(state({ layers: [8] }), config),
    /active layers/,
  );
  assert.throws(
    () =>
      parseSnapshot(
        state({
          pressed: [
            [0, 0],
            [0, 0],
          ],
        }),
        config,
      ),
    /held positions/,
  );
});

test("recursive or unknown action descriptions terminate safely", () => {
  const config = parseConfiguration(frames());
  config.behaviors[7].children = [[7, 0, 0]];
  assert.equal(bindingLabel(config, [7, 0, 0]).tap, "Recursive");
  assert.equal(bindingLabel(config, [0, 0, 0]).tap, "Unassigned");
});

test("typing overlay sizes include only keys, padding, and the live layer label", () => {
  const config = parseConfiguration(frames());
  const bounds = viewerBounds(config);
  const normal = viewerOverlaySize(config, 100);
  const larger = viewerOverlaySize(config, 120);
  assert.equal(normal.width, bounds[2] * 58 + 24);
  assert.equal(normal.height, bounds[3] * 58 + 52);
  assert.ok(Math.abs(larger.width - 24 - (normal.width - 24) * 1.2) < 1e-9);
  assert.ok(Math.abs(larger.height - 52 - (normal.height - 52) * 1.2) < 1e-9);
  assert.equal(viewerOverlaySize(config, 100, 208).height, normal.height + 208);
});

function shortcutConfiguration() {
  const data = frames();
  const key = data.find((frame) => frame.type === "key");
  data.splice(1, 0, { ...key, position: 3, x: 300, rx: 300 });
  for (const frame of data.filter((frame) => frame.type === "layer")) {
    frame.bindings.push([1, 0x70028, 0]);
    if (frame.id === 0) {
      frame.bindings[0] = [2, 0x700e1, 0x7002a];
      frame.bindings[2] = [1, 0x7002b, 0];
    }
  }
  return parseConfiguration(data);
}

test("viewer chords use physical base-layer tap identities across layer-tap holds", () => {
  const config = shortcutConfiguration();
  const shortcut = (pressed, layers = [0]) =>
    viewerShortcuts(config, parseSnapshot(state({ pressed, layers }), config));
  assert.deepEqual(shortcut([[1, 0]]), { display: false, combos: false });
  assert.deepEqual(
    shortcut(
      [
        [0, 9],
        [1, 0],
      ],
      [9, 0],
    ),
    {
      display: true,
      combos: false,
    },
  );
  assert.deepEqual(
    shortcut(
      [
        [2, 9],
        [3, 9],
      ],
      [9, 0],
    ),
    {
      display: false,
      combos: true,
    },
  );
  assert.deepEqual(
    shortcut([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]),
    {
      display: true,
      combos: true,
    },
  );
  assert.deepEqual(shortcut([]), { display: false, combos: false });
});

test("held chords toggle once and rearm only after a chord key is released", () => {
  const idle = { display: false, combos: false };
  const held = { display: true, combos: true };
  assert.deepEqual(viewerShortcutEdges(idle, held), held);
  assert.deepEqual(viewerShortcutEdges(held, held), idle);
  assert.deepEqual(viewerShortcutEdges(held, idle), idle);
  assert.deepEqual(viewerShortcutEdges(idle, held), held);
  assert.deepEqual(
    viewerShortcutEdges(held, { display: true, combos: false }),
    idle,
  );
  assert.deepEqual(
    viewerShortcutEdges({ display: true, combos: false }, held),
    { display: false, combos: true },
  );
});

test("modified outputs and recursive tap bindings do not trigger viewer chords", () => {
  const config = shortcutConfiguration();
  config.layers[0].bindings[2] = [1, 0x0107002b, 0];
  config.behaviors[3].children[1] = [3, 0, 0];
  assert.deepEqual(
    viewerShortcuts(
      config,
      parseSnapshot(
        state({
          pressed: [
            [0, 0],
            [1, 0],
            [2, 0],
            [3, 0],
          ],
        }),
        config,
      ),
    ),
    { display: false, combos: false },
  );
});
