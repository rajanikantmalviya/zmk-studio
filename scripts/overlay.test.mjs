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
      entry: fileURLToPath(new URL("../src/overlay/model.ts", import.meta.url)),
      formats: ["es"],
    },
  },
});
const chunk = output[0].output.find((item) => item.type === "chunk");
const {
  buildOverlayLayers,
  describeOutput,
  modifierMask,
  matchesOutput,
  isOutputHeld,
  isMonitoredOutput,
  createLearningSession,
  advanceLearningSession,
  layoutBounds,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

const physical = (x, y, r = 0) => ({
  x,
  y,
  width: 100,
  height: 100,
  r,
  rx: 0,
  ry: 0,
});
const layout = { name: "Test", keys: [physical(0, 0), physical(100, 0)] };
const hid = [{ hidUsage: { keyboardMax: 231, consumerMax: 767 } }];
const behaviors = {
  1: {
    id: 1,
    displayName: "Key Press",
    metadata: [{ param1: hid, param2: [] }],
  },
  2: {
    id: 2,
    displayName: "Hold Tap",
    metadata: [{ param1: hid, param2: hid }],
  },
};
const keymap = {
  layers: [
    {
      id: 5,
      name: "Base",
      bindings: [
        { behaviorId: 1, param1: 0x70004, param2: 0 },
        { behaviorId: 1, param1: 0x70005, param2: 0 },
      ],
    },
    {
      id: 9,
      name: "Other",
      bindings: [
        { behaviorId: 1, param1: 0x01070006, param2: 0 },
        { behaviorId: 2, param1: 0x700e0, param2: 0x70007 },
      ],
    },
  ],
  availableLayers: 1,
  maxLayerNameLength: 16,
};
const config = () => ({
  deviceName: "Test",
  layers: buildOverlayLayers(keymap, layout, behaviors),
  displayedLayerId: 5,
  learning: {
    sessionId: "test-session",
    mode: "find-key",
    count: 10,
    hints: true,
  },
});
const keyEvent = (usage, pressed = true) => ({ usage, pressed, sequence: 1 });

test("overlay reflects the physical layout and maps output candidates without inventing telemetry", () => {
  const layers = buildOverlayLayers(keymap, layout, behaviors);
  assert.equal(layers[0].keys[1].x, 1);
  assert.equal(layers[0].keys[0].width, 1);
  assert.deepEqual(layers[1].keys[0].outputs, [0x01070006]);
  assert.deepEqual(layers[1].keys[1].outputs, [0x700e0, 0x70007]);
  assert.equal(layers[1].keys[1].trainable, false);
  assert.equal(layers[0].keys[0].trainable, true);
});

test("unassigned positions remain visible but cannot become training targets", () => {
  const map = structuredClone(keymap);
  map.layers[0].bindings[0] = { behaviorId: 0, param1: 0, param2: 0 };
  const key = buildOverlayLayers(map, layout, behaviors)[0].keys[0];
  assert.equal(key.label, "Unassigned");
  assert.deepEqual(key.outputs, []);
  assert.equal(key.trainable, false);
});

test("highlights include modifier requirements and distinguish right-side modifiers", () => {
  const pressed = new Set([0x700e0, 0x700e7, 0x70006]);
  assert.equal(modifierMask(pressed), 0x81);
  assert.equal(isOutputHeld(0x81070006, pressed), true);
  assert.equal(isOutputHeld(0x02070006, pressed), false);
  assert.equal(isOutputHeld(0x81070005, pressed), false);
  assert.equal(matchesOutput(0x81070006, 0x70006, pressed), true);
  assert.equal(matchesOutput(0x01070006, 0x70006, pressed), false);
  assert.equal(matchesOutput(0x700e0, 0x700e0, new Set([0x700e0])), true);
  assert.match(describeOutput(0x80070006), /R GUI/);
});

test("only observable usages can be practiced", () => {
  assert.equal(isMonitoredOutput(0x70004), true);
  assert.equal(isMonitoredOutput(0x800700e7), true);
  assert.equal(isMonitoredOutput(0x70073), true);
  assert.equal(isMonitoredOutput(0xc00e2), true);
  assert.equal(isMonitoredOutput(0xc006f), false);
  assert.equal(isMonitoredOutput(0x70032), false);
  assert.equal(isMonitoredOutput(0x70066), false);
  assert.equal(isMonitoredOutput(0), false);
});

test("learning uses the manually selected layer and cycles through all eligible keys", () => {
  const configuration = config();
  let session = createLearningSession(configuration, () => 0);
  assert.equal(session.targets.length, 10);
  assert.deepEqual(
    session.targets.slice(0, 2).map((target) => target.position),
    [0, 1],
  );
  for (let index = 0; index < 10; index++) {
    const target = session.targets[session.correct];
    session = advanceLearningSession(
      session,
      keyEvent(target.output),
      new Set([target.output]),
      5,
    );
  }
  assert.equal(session.correct, 10);
  assert.equal(session.attempts, 10);
  assert.equal(
    advanceLearningSession(session, keyEvent(0x70004), new Set([0x70004]), 5),
    session,
  );
  configuration.displayedLayerId = 9;
  configuration.learning.mode = "layer-drill";
  const other = createLearningSession(configuration, () => 0);
  assert.ok(
    other.targets.every(
      (target) => target.layerId === 9 && target.position === 0,
    ),
  );
  assert.equal(other.mode, "layer-drill");
});

test("wrong output increments attempts, key-up and preparatory modifiers do not", () => {
  const configuration = config();
  configuration.displayedLayerId = 9;
  let session = createLearningSession(configuration, () => 0);
  assert.equal(
    advanceLearningSession(session, keyEvent(0x700e0), new Set([0x700e0]), 9),
    session,
  );
  assert.equal(
    advanceLearningSession(session, keyEvent(0x70006, false), new Set(), 9),
    session,
  );
  session = advanceLearningSession(
    session,
    keyEvent(0x70006),
    new Set([0x70006]),
    9,
  );
  assert.equal(session.correct, 0);
  assert.equal(session.attempts, 1);
  session = advanceLearningSession(
    session,
    keyEvent(0x70006),
    new Set([0x700e0, 0x70006]),
    9,
  );
  assert.equal(session.correct, 1);
  assert.equal(session.attempts, 2);
});

test("manual layer mismatch pauses learning without claiming automatic layer detection", () => {
  const session = createLearningSession(config(), () => 0);
  const next = advanceLearningSession(
    session,
    keyEvent(0x70004),
    new Set([0x70004]),
    9,
  );
  assert.equal(next.correct, 0);
  assert.equal(next.attempts, 0);
  assert.match(next.feedback, /Select displayed layer/);
});

test("invalid or unsupported learning sessions fail explicitly", () => {
  const configuration = config();
  configuration.learning = null;
  assert.throws(() => createLearningSession(configuration), /requested/);
  configuration.learning = {
    sessionId: "test",
    mode: "find-key",
    count: 0,
    hints: false,
  };
  assert.throws(
    () => createLearningSession(configuration),
    /between 1 and 100/,
  );
  configuration.learning.count = 10;
  configuration.displayedLayerId = 999;
  assert.throws(() => createLearningSession(configuration), /not available/);
  configuration.displayedLayerId = 5;
  configuration.layers[0].keys.forEach((key) => {
    key.trainable = false;
  });
  assert.throws(() => createLearningSession(configuration), /no supported/);
});

test("layout bounds include rotations about an explicit zero origin", () => {
  const key = {
    ...config().layers[0].keys[0],
    x: 1,
    y: 0,
    r: 90,
    rx: 0,
    ry: 0,
  };
  const [x, y, width, height] = layoutBounds([key]);
  assert.ok(x <= -1);
  assert.ok(y <= 1);
  assert.ok(width >= 1);
  assert.ok(height >= 2);
  assert.ok(layoutBounds([]).every(Number.isFinite));
});
