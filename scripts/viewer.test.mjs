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
  shiftedKeyValue,
  viewerBounds,
  viewerOverlaySize,
  viewerShortcuts,
  viewerShortcutEdges,
  toggleViewerPanel,
  macroStepLabel,
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
    shifted: "A",
    hold: "Lshft",
  });
  assert.deepEqual(bindingLabel(config, [2, 0x700e4, 0x7000f]), {
    tap: "L",
    shifted: "L",
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

test("firmware-defined home-row layer tap keeps its tap, shift and layer labels", () => {
  const input = frames();
  input.splice(-1, 0, {
    type: "behavior",
    id: 8,
    name: "Home Row Layer Tap",
    kind: "hold-tap",
    children: [
      [4, 0, 0],
      [1, 0, 0],
    ],
  });
  input.find((frame) => frame.type === "layer" && frame.id === 0).bindings[0] =
    [8, 9, 0x70004];
  const config = parseConfiguration(input);
  assert.deepEqual(bindingLabel(config, [8, 9, 0x70004]), {
    tap: "A",
    shifted: "A",
    hold: "Nav",
  });
  const held = parseSnapshot(
    state({ layers: [9, 0], pressed: [[0, 0]] }),
    config,
  );
  const keys = displayedKeys(config, held);
  assert.equal(keys[0].tap, "A");
  assert.equal(keys[0].shifted, "A");
  assert.equal(keys[0].hold, "Nav");
  assert.equal(keys[0].pressed, true);
});

test("shift legends cover US letters, digits and punctuation, not non-text actions", () => {
  for (let id = 4; id <= 29; id++)
    assert.equal(
      shiftedKeyValue(0x70000 | id),
      String.fromCharCode(65 + id - 4),
    );
  for (let offset = 0; offset < 10; offset++)
    assert.equal(shiftedKeyValue(0x7001e + offset), "!@#$%^&*()"[offset]);
  for (const [id, label] of [
    [0x2d, "_"],
    [0x2e, "+"],
    [0x2f, "{"],
    [0x30, "}"],
    [0x31, "|"],
    [0x33, ":"],
    [0x34, '"'],
    [0x35, "~"],
    [0x36, "<"],
    [0x37, ">"],
    [0x38, "?"],
  ])
    assert.equal(shiftedKeyValue(0x70000 | id), label);
  assert.equal(shiftedKeyValue(0x0207001e), "!");
  assert.equal(shiftedKeyValue(0x20070038), "?");
  for (const usage of [
    0x70028, 0x7002c, 0x70050, 0x700e1, 0xc00b5, 0x01070006, 0x0407001e,
    0x08070004, 0x80070004, 0,
  ])
    assert.equal(shiftedKeyValue(usage), undefined);
});

test("shift legends follow tap bindings, active layers and held-key origins", () => {
  const input = frames();
  input.find((frame) => frame.type === "layer" && frame.id === 9).bindings[0] =
    [1, 0x7001e, 0];
  const config = parseConfiguration(input);
  assert.equal(bindingLabel(config, [4, 9, 0]).shifted, undefined);
  assert.equal(bindingLabel(config, [1, 0x01070006, 0]).shifted, undefined);
  const base = displayedKeys(config, parseSnapshot(state(), config));
  assert.equal(base[0].shifted, "A");
  assert.equal(base[0].hold, "Lshft");
  assert.equal(base[1].shifted, undefined);
  const upper = displayedKeys(
    config,
    parseSnapshot(state({ layers: [9, 0] }), config),
  );
  assert.equal(upper[0].shifted, "!");
  assert.equal(upper[2].shifted, "B");
  const held = displayedKeys(
    config,
    parseSnapshot(state({ layers: [9, 0], pressed: [[0, 0]] }), config),
  );
  assert.equal(held[0].shifted, "A");
  assert.equal(held[0].hold, "Lshft");
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

test("combo scopes retain inactive layer indices without accepting stale active layers", () => {
  const data = frames();
  data.find((frame) => frame.type === "combo").layers = [0, 1, 2, 3, 4, 5];
  const config = parseConfiguration(data);
  assert.deepEqual(config.combos[0].layers, [0, 1, 2, 3, 4, 5]);
  assert.throws(() => parseSnapshot(state({ layers: [5] }), config), /layer/);
  const duplicate = frames();
  duplicate.find((frame) => frame.type === "combo").layers = [0, 0];
  assert.throws(() => parseConfiguration(duplicate), /combo/);
  const outOfRange = frames();
  outOfRange.find((frame) => frame.type === "combo").layers = [32];
  assert.throws(() => parseConfiguration(outOfRange), /integer/);
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
  assert.deepEqual(shortcut([[1, 0]]), {
    display: false,
    combos: false,
    macros: false,
  });
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
      macros: false,
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
      macros: false,
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
      macros: false,
    },
  );
  assert.deepEqual(shortcut([]), {
    display: false,
    combos: false,
    macros: false,
  });
});

test("held chords toggle once and rearm only after a chord key is released", () => {
  const idle = { display: false, combos: false, macros: false };
  const held = { display: true, combos: true, macros: false };
  assert.deepEqual(viewerShortcutEdges(idle, held), held);
  assert.deepEqual(viewerShortcutEdges(held, held), idle);
  assert.deepEqual(viewerShortcutEdges(held, idle), idle);
  assert.deepEqual(viewerShortcutEdges(idle, held), held);
  assert.deepEqual(
    viewerShortcutEdges(held, { display: true, combos: false, macros: false }),
    idle,
  );
  assert.deepEqual(
    viewerShortcutEdges({ display: true, combos: false, macros: false }, held),
    { display: false, combos: true, macros: false },
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
    { display: false, combos: false, macros: false },
  );
});

test("Esc+Delete toggles macros despite layer-tap holds and never repeats while held", () => {
  const config = shortcutConfiguration();
  config.layers[0].bindings[0] = [3, 9, 0x70029];
  config.layers[0].bindings[1] = [3, 9, 0x7004c];
  const held = viewerShortcuts(
    config,
    parseSnapshot(
      state({
        pressed: [
          [0, 0],
          [1, 9],
        ],
        layers: [9, 0],
      }),
      config,
    ),
  );
  assert.deepEqual(held, { display: false, combos: false, macros: true });
  assert.deepEqual(viewerShortcutEdges(held, held), {
    display: false,
    combos: false,
    macros: false,
  });
});

test("viewer lists toggle closed and switching lists leaves only one active", () => {
  assert.equal(toggleViewerPanel(undefined, "combos"), "combos");
  assert.equal(toggleViewerPanel("combos", "combos"), undefined);
  assert.equal(toggleViewerPanel("combos", "macros"), "macros");
  assert.equal(toggleViewerPanel("macros", "macros"), undefined);
});

test("runtime macro names, steps, capabilities and disabled combos are retained", () => {
  const data = frames();
  data.splice(
    -1,
    0,
    {
      type: "behavior",
      id: 8,
      name: "Runtime Macro",
      kind: "runtime-macro",
      children: [],
    },
    {
      type: "capabilities",
      runtimeCombos: true,
      runtimeMacros: true,
      bleStreaming: true,
    },
    {
      type: "macro",
      slot: 2,
      name: "Save",
      source: "runtime",
      hasUnsavedChanges: true,
      steps: [
        { kind: "press", binding: [1, 0x700e0, 0] },
        { kind: "tap", binding: [1, 0x70016, 0] },
        { kind: "delay", delayMs: 10 },
        { kind: "release", binding: [1, 0x700e0, 0] },
      ],
    },
  );
  const combo = data.find((frame) => frame.type === "combo");
  combo.binding = [8, 2, 0];
  combo.enabled = false;
  const config = parseConfiguration(data);
  assert.equal(bindingLabel(config, combo.binding).tap, "Save");
  assert.equal(config.combos[0].enabled, false);
  assert.equal(config.macros[0].hasUnsavedChanges, true);
  assert.equal(config.capabilities.bleStreaming, true);
  assert.deepEqual(
    config.macros[0].steps.map((step) => macroStepLabel(config, step)),
    ["press: Lctrl", "tap: S", "Wait 10 ms", "release: Lctrl"],
  );
});

test("invalid macro steps, duplicate slots and unknown bindings fail explicitly", () => {
  const macro = {
    type: "macro",
    slot: 0,
    name: "Test",
    steps: [{ kind: "tap", binding: [1, 0x70004, 0] }],
  };
  assert.throws(
    () => parseConfiguration([...frames(), macro, macro]),
    /Duplicate runtime macro/,
  );
  assert.throws(
    () =>
      parseConfiguration([
        ...frames(),
        { ...macro, steps: [{ kind: "unknown" }] },
      ]),
    /Unknown firmware macro step/,
  );
  assert.throws(
    () =>
      parseConfiguration([
        ...frames(),
        { ...macro, steps: [{ kind: "tap", binding: [999, 0, 0] }] },
      ]),
    /Unknown firmware behavior/,
  );
  assert.deepEqual(parseConfiguration(frames()).macros, []);
});
