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
      entry: fileURLToPath(
        new URL("../src/viewer/learning.ts", import.meta.url),
      ),
      formats: ["es"],
    },
  },
});
const chunk = result[0].output.find((item) => item.type === "chunk");
const {
  learningKeys,
  practiceText,
  startSession,
  stopSession,
  resumeSession,
  recordAttempt,
  elapsedMs,
  sessionMetrics,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

function configuration() {
  return {
    defaultLayer: 3,
    keys: Array.from({ length: 8 }, (_, position) => ({ position })),
    behaviors: {
      1: { kind: "key" },
      2: {
        kind: "hold-tap",
        children: [
          [1, 0, 0],
          [1, 0, 0],
        ],
      },
      3: { kind: "transparent" },
      4: { kind: "runtime-macro" },
      5: { kind: "momentary-layer" },
      6: {
        kind: "hold-tap",
        children: [
          [5, 0, 0],
          [1, 0, 0],
        ],
      },
      7: { kind: "tap-dance", children: [[1, 0x70004, 0]] },
    },
    layers: [
      {
        id: 3,
        bindings: [
          [2, 0x700e1, 0x70004],
          [6, 9, 0x7002c],
          [1, 0x7001e, 0],
          [1, 0x01070006, 0],
          [4, 0, 0],
          [1, 0x70050, 0],
          [1, 0x70004, 0],
          [7, 0, 0],
        ],
      },
      {
        id: 9,
        bindings: [
          [3, 0, 0],
          [1, 0x70038, 0],
          [1, 0x02070005, 0],
          [1, 0x700e5, 0],
          [1, 0xc00b0, 0],
          [1, 0x0207002c, 0],
          [1, 0x04070007, 0],
          [1, 0x7002f, 0],
        ],
      },
    ],
  };
}

test("learning keys use tap identities, exclude shortcuts/macros/navigation, and deduplicate", () => {
  assert.deepEqual(learningKeys(configuration(), 3, false), [
    { character: "a", position: 0, shifted: false },
    { character: " ", position: 1, shifted: false },
    { character: "1", position: 2, shifted: false },
  ]);
});

test("shift drills include HRM Shift, layer fallback, explicit Shift chords and punctuation", () => {
  const keys = learningKeys(configuration(), 9, true);
  assert.deepEqual(
    keys.map((key) => key.character),
    ["a", "A", "/", "?", "B", " ", "[", "{"],
  );
  assert.deepEqual(
    keys.find((key) => key.character === "A"),
    {
      character: "A",
      position: 0,
      shifted: true,
    },
  );
  assert.equal(keys.find((key) => key.character === "B").shifted, false);
  // A Shift hold-tap cannot shift its own tap without another Shift key.
  const onlyHrm = configuration();
  onlyHrm.layers[0].bindings[6] = [4, 0, 0];
  assert.ok(
    !learningKeys(onlyHrm, 3, true).some((key) => key.character === "A"),
  );
  assert.equal(
    learningKeys(configuration(), 3, true).find((key) => key.character === "A")
      .position,
    6,
  );
  assert.ok(
    learningKeys(configuration(), 3, true).some((key) => key.character === "!"),
  );
  const noShift = configuration();
  noShift.layers[0].bindings[0] = [1, 0x70004, 0];
  assert.deepEqual(
    learningKeys(noShift, 3, true).map((key) => key.character),
    ["a", " ", "1"],
  );
});

test("drills cover every printable mapping without inventing unavailable characters", () => {
  for (const layerId of [3, 9]) {
    const keys = learningKeys(configuration(), layerId, true);
    const text = practiceText(keys, "keys", () => 0.5);
    for (const key of keys) assert.ok(text.includes(key.character));
    for (const character of text)
      assert.ok(keys.some((key) => key.character === character));
  }
  assert.equal(practiceText([], "keys"), "");
  assert.equal(practiceText([{ character: " " }], "words"), "");
  assert.equal(practiceText([{ character: "x" }], "keys"), "xxxxx");
});

test("word sessions filter words to the keymap and fall back for limited symbol layouts", () => {
  const keys = [..."the "].map((character) => ({ character }));
  const text = practiceText(keys, "words", () => 0);
  assert.equal(text.trim().split(" ").length, 12);
  assert.ok(text.includes("he"));
  for (const character of text) assert.ok("the ".includes(character));
  for (const characters of ["/[]", "/[] "]) {
    const fallback = practiceText(
      [...characters].map((character) => ({ character })),
      "words",
      () => 0.5,
    );
    assert.ok(fallback.length);
    for (const character of fallback) assert.ok(characters.includes(character));
  }
});

test("WPM counts only correct characters, uses five characters per word and partial windows", () => {
  let session = startSession(300000, 1000);
  assert.equal(sessionMetrics(session, 1000).average, 0);
  for (let index = 0; index < 50; index++)
    session = recordAttempt(session, true, 1000 + index * 100);
  session = recordAttempt(session, false, 7000);
  const metrics = sessionMetrics(session, 31000);
  assert.equal(metrics.average, 20);
  assert.equal(metrics.minute, 20);
  assert.equal(metrics.twoMinutes, 20);
  assert.equal(metrics.correct, 50);
  assert.equal(metrics.mistakes, 1);
  assert.equal(metrics.accuracy, (50 / 51) * 100);
});

test("rolling windows expire independently and exclude their exact lower boundary", () => {
  let session = startSession(300000, 0);
  for (const time of [0, 30000, 60000, 90000, 120000, 150000])
    session = recordAttempt(session, true, time);
  const metrics = sessionMetrics(session, 150000);
  assert.equal(metrics.average, 6 / 5 / 2.5);
  assert.equal(metrics.minute, 2 / 5);
  assert.equal(metrics.twoMinutes, 4 / 5 / 2);
  assert.equal(sessionMetrics(session, 220000).minute, 0);
});

test("pauses exclude wall time from average, rolling windows and duration", () => {
  let session = startSession(300000, 1000);
  session = recordAttempt(session, true, 11000);
  session = stopSession(session, 31000);
  assert.equal(elapsedMs(session, 900000), 30000);
  assert.equal(sessionMetrics(session, 900000).minute, 0.4);
  assert.equal(recordAttempt(session, true, 900000), session);
  session = resumeSession(session, 900000);
  session = recordAttempt(session, true, 930000);
  assert.equal(elapsedMs(session, 930000), 60000);
  assert.equal(sessionMetrics(session, 930000).average, 0.4);
  assert.equal(sessionMetrics(session, 970000).minute, 0.2);
});

test("timed and manual completion freeze results and do not accept late attempts", () => {
  let session = startSession(60000, 1000);
  session = recordAttempt(session, true, 2000);
  session = recordAttempt(session, true, 61000);
  assert.equal(session.status, "finished");
  assert.equal(session.attempts.length, 1);
  assert.equal(elapsedMs(session, 900000), 60000);
  assert.equal(sessionMetrics(session, 900000).average, 0.2);
  assert.equal(resumeSession(session, 900000), session);
  assert.equal(recordAttempt(session, true, 900000), session);
  const manual = stopSession(startSession(300000, 0), 10000, true);
  assert.equal(manual.status, "finished");
  assert.equal(elapsedMs(manual, 900000), 10000);
  assert.equal(stopSession(startSession(60000, 0), 70000).status, "finished");
});
