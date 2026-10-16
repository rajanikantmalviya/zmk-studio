import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Expected injected transport failures and per-request logging are not device
// evidence. Suppress them so the test runner reports assertions, not keymaps.
console.log = () => {};
console.error = () => {};

async function load(path) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      lib: {
        entry: fileURLToPath(new URL(path, import.meta.url)),
        formats: ["es"],
      },
    },
  });
  const chunk = result[0].output.find((item) => item.type === "chunk");
  return import(
    `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
  );
}
const [
  clientModule,
  model,
  backupModule,
  keymapModule,
  wire,
  rpcModule,
  framing,
] = await Promise.all([
  load("../src/runtime/client.ts"),
  load("../src/runtime/model.ts"),
  load("../src/runtime/backup.ts"),
  load("../src/keyboard/keymapBackup.ts"),
  load("../vendor/zmk-studio-ts-client/src/studio.ts"),
  load("../vendor/zmk-studio-ts-client/src/index.ts"),
  load("../vendor/zmk-studio-ts-client/src/framing.ts"),
]);
const { RuntimeClient, combo, macro, COMBO_IDENTIFIER, MACRO_IDENTIFIER } =
  clientModule;
const {
  createStudioBackup,
  studioBackupJSON,
  planStudioRestore,
  applyStudioBackup,
} = backupModule;
const { parseKeymapBackup, createKeymapBackup } = keymapModule;
const key = (usage = 4) => ({
  behaviorId: 1,
  param1: (7 << 16) | usage,
  param2: 0,
});
const clean = (value) => JSON.parse(JSON.stringify(value));
const macroBinding = (slot) => ({ behaviorId: 2, param1: slot, param2: 0 });
const behaviors = {
  1: {
    id: 1,
    displayName: "Key Press",
    metadata: [
      { param1: [{ range: { min: 0, max: 0xffffffff } }], param2: [] },
    ],
  },
  2: {
    id: 2,
    displayName: "Runtime Macro",
    metadata: [{ param1: [{ range: { min: 0, max: 7 } }], param2: [] }],
  },
  3: {
    id: 3,
    displayName: "Momentary Layer",
    metadata: [{ param1: [{ layerId: {} }], param2: [] }],
  },
};
const layout = {
  name: "Two keys",
  keys: [0, 1].map((x) => ({
    x: x * 100,
    y: 0,
    width: 100,
    height: 100,
    r: 0,
    rx: 0,
    ry: 0,
  })),
};
const map = (binding = key()) => ({
  layers: [{ id: 10, name: "Base", bindings: [binding, key(5)] }],
  availableLayers: 3,
  maxLayerNameLength: 16,
});
const definition = (slot = 1, name = "Greeting", steps = [{ tap: key() }]) => ({
  slot,
  name,
  steps,
  encodedSize: model.macroEncodedSize(steps),
});
const comboDefinition = (index = 0, binding = key()) => ({
  index,
  name: "Two key combo",
  keyPositions: [0, 1],
  behavior: binding,
  layerMask: 0,
  enabled: true,
  timeoutMs: 0,
  requirePriorIdleMs: 0,
  slowReleaseOverride: 0,
  source: 1,
});
const snapshot = (slot = 1) => ({
  combos: {
    settings: {
      timeoutMs: 50,
      slowRelease: false,
      maxCombo: 2,
      requirePriorIdleMs: 0,
    },
    definitions: [
      comboDefinition(0, macroBinding(slot)),
      {
        ...comboDefinition(1),
        name: "",
        enabled: false,
        keyPositions: [],
        behavior: undefined,
        source: 0,
      },
    ],
  },
  macros: {
    settings: {
      tapMs: 5,
      maxEntries: 8,
      keyPressBehaviorId: 1,
      poolBytesTotal: 1536,
      poolBytesUsed: 24,
    },
    maxBytes: 256,
    maxNameLength: 24,
    summaries: [
      { slot, name: "Greeting", encodedSize: 8, hasUnsavedChanges: false },
    ],
    definitions: [definition(slot)],
  },
});
function connection(handler) {
  let controller;
  const requests = [];
  return {
    conn: {
      label: "simulated",
      current_request: 0,
      request_writable: new WritableStream({
        async write(request) {
          requests.push(request);
          controller.enqueue({
            requestId: request.requestId,
            ...(await handler(request)),
          });
        },
      }),
      request_response_readable: new ReadableStream({
        start(value) {
          controller = value;
        },
      }),
      notification_readable: new ReadableStream(),
    },
    requests,
  };
}
function device(
  initial = snapshot(),
  initialMap = map(),
  failure = () => false,
) {
  const state = structuredClone(initial),
    keymap = structuredClone(initialMap);
  const events = [];
  const wireConnection = connection(async (request) => {
    if (request.keymap) {
      const kind = `keymap.${Object.keys(request.keymap)[0]}`;
      events.push(kind);
      if (failure(kind, request, events)) return { keymap: {} };
      if (request.keymap.saveChanges)
        return { keymap: { saveChanges: { ok: true } } };
      if (request.keymap.discardChanges)
        return { keymap: { discardChanges: true } };
      throw new Error(`Unexpected simulated keymap request: ${kind}`);
    }
    if (request.custom?.listCustomSubsystems)
      return {
        custom: {
          listCustomSubsystems: {
            subsystems: [
              ...(state.combos
                ? [{ index: 9, identifier: COMBO_IDENTIFIER, uiUrl: [] }]
                : []),
              ...(state.macros
                ? [{ index: 7, identifier: MACRO_IDENTIFIER, uiUrl: [] }]
                : []),
            ],
          },
        },
      };
    const call = request.custom?.call;
    assert.ok(call, "must use typed custom envelope");
    const codec = call.subsystemIndex === 9 ? combo : macro;
    const decoded = codec.Request.decode(call.payload);
    const kind = Object.keys(decoded).find((key) => decoded[key] !== undefined);
    events.push(kind);
    let response;
    if (failure(kind, decoded, events))
      response = { error: { message: `Injected failure: ${kind}` } };
    else if (kind === "getGlobalSettings")
      response = { getGlobalSettings: { settings: state.combos.settings } };
    else if (kind === "listCombos")
      response = { listCombos: { combos: state.combos.definitions } };
    else if (kind === "getMacroGlobalSettings")
      response = {
        getMacroGlobalSettings: { settings: state.macros.settings },
      };
    else if (kind === "listMacros")
      response = {
        listMacros: {
          macros: state.macros.definitions.map((item) => ({
            ...item,
            hasUnsavedChanges: true,
          })),
          maxMacroBytes: state.macros.maxBytes,
          maxNameLength: state.macros.maxNameLength,
        },
      };
    else if (kind === "getMacro")
      response = {
        getMacro: {
          macro: state.macros.definitions.find(
            (item) => item.slot === decoded.getMacro.slot,
          ),
        },
      };
    else {
      if (kind === "setCombo") {
        const input = decoded.setCombo;
        const prior = state.combos.definitions.find(
          (item) => item.index === input.index,
        );
        Object.assign(prior, input);
      } else if (kind === "setComboName")
        state.combos.definitions.find(
          (item) => item.index === decoded.setComboName.index,
        ).name = decoded.setComboName.name;
      else if (kind === "deleteCombo") {
        const item = state.combos.definitions.find(
          (item) => item.index === decoded.deleteCombo.index,
        );
        item.enabled = false;
      } else if (kind === "setTimeoutMs")
        state.combos.settings.timeoutMs = decoded.setTimeoutMs.timeoutMs;
      else if (kind === "setSlowRelease")
        state.combos.settings.slowRelease = decoded.setSlowRelease.slowRelease;
      else if (kind === "setRequirePriorIdleMs")
        state.combos.settings.requirePriorIdleMs =
          decoded.setRequirePriorIdleMs.requirePriorIdleMs;
      else if (kind === "createMacro") {
        const slot = Array.from(
          { length: state.macros.settings.maxEntries },
          (_, slot) => slot,
        ).find(
          (slot) =>
            !state.macros.definitions.some((item) => item.slot === slot),
        );
        state.macros.definitions.push(
          definition(slot, decoded.createMacro.name, []),
        );
      } else if (kind === "deleteMacro")
        state.macros.definitions = state.macros.definitions.filter(
          (item) => item.name !== decoded.deleteMacro.name,
        );
      else if (kind === "renameMacro")
        state.macros.definitions.find(
          (item) => item.name === decoded.renameMacro.oldName,
        ).name = decoded.renameMacro.newName;
      else if (kind === "resetMacro")
        state.macros.definitions = state.macros.definitions.filter(
          (item) => item.slot !== decoded.resetMacro.slot,
        );
      else if (kind === "setMacroStepCount")
        state.macros.definitions.find(
          (item) => item.slot === decoded.setMacroStepCount.slot,
        ).steps.length = decoded.setMacroStepCount.stepCount;
      else if (kind === "appendMacroStep")
        state.macros.definitions
          .find((item) => item.slot === decoded.appendMacroStep.slot)
          .steps.push(decoded.appendMacroStep.step);
      else if (kind === "setTapMs")
        state.macros.settings.tapMs = decoded.setTapMs.tapMs;
      for (const item of state.macros?.definitions ?? [])
        item.encodedSize = model.macroEncodedSize(item.steps);
      response = {
        status: { affectedCount: 1, message: "simulated acknowledgement" },
      };
    }
    return {
      custom: {
        call: {
          subsystemIndex: call.subsystemIndex,
          payload: codec.Response.encode(response).finish(),
        },
      },
    };
  });
  return {
    state,
    keymap,
    events,
    ...wireConnection,
    client: new RuntimeClient(
      wireConnection.conn,
      state.combos ? 9 : undefined,
      state.macros ? 7 : undefined,
    ),
    rpc: async (request) => {
      events.push(`keymap.${Object.keys(request.keymap)[0]}`);
      if (request.keymap.getKeymap)
        return { keymap: { getKeymap: structuredClone(keymap) } };
      if (request.keymap.setLayerProps) {
        const { layerId, name } = request.keymap.setLayerProps;
        keymap.layers.find((item) => item.id === layerId).name = name;
        return { keymap: { setLayerProps: 0 } };
      }
      if (request.keymap.setLayerBinding) {
        const { layerId, keyPosition, binding } =
          request.keymap.setLayerBinding;
        keymap.layers.find((item) => item.id === layerId).bindings[
          keyPosition
        ] = structuredClone(binding);
        return { keymap: { setLayerBinding: 0 } };
      }
      throw new Error("Unexpected simulated keymap operation");
    },
  };
}

test("custom envelope round-trips exact binary payload without dropping fields", () => {
  const request = {
    requestId: 42,
    custom: {
      call: {
        subsystemIndex: 9,
        payload: new Uint8Array([0, 1, 0xfc, 0xfd, 0xfe, 0xff]),
      },
    },
  };
  assert.deepEqual(
    wire.Request.decode(wire.Request.encode(request).finish()).custom.call,
    request.custom.call,
  );
  const response = {
    requestResponse: { requestId: 42, custom: { call: request.custom.call } },
  };
  assert.deepEqual(
    wire.Response.decode(wire.Response.encode(response).finish())
      .requestResponse.custom.call,
    request.custom.call,
  );
});
test("typed custom requests survive raw Studio framing and arbitrarily split replies", async () => {
  let responses;
  const bytes = [],
    requests = [];
  const decoder = framing.get_decoder(),
    encoder = framing.get_encoder();
  const transport = {
    label: "simulated raw transport",
    abortController: new AbortController(),
    readable: new ReadableStream({
      start(controller) {
        responses = controller;
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        bytes.push(...chunk);
        decoder.transform(chunk, {
          enqueue(payload) {
            const request = wire.Request.decode(payload);
            requests.push(request);
            const reply = wire.Response.encode({
              requestResponse: {
                requestId: request.requestId,
                custom: { call: request.custom.call },
              },
            }).finish();
            encoder.transform(reply, {
              enqueue(framed) {
                for (const byte of framed)
                  responses.enqueue(new Uint8Array([byte]));
              },
              error(error) {
                throw error;
              },
            });
          },
          error(error) {
            throw error;
          },
        });
      },
    }),
  };
  const conn = rpcModule.create_rpc_connection(transport);
  const payload = new Uint8Array([0xab, 0xac, 0xad, 0, 0xff]);
  const response = await rpcModule.call_rpc(conn, {
    custom: { call: { subsystemIndex: 17, payload } },
  });
  assert.deepEqual(response.custom.call.payload, payload);
  assert.deepEqual(requests[0].custom.call.payload, payload);
  assert.equal(bytes[0], 0xab);
  assert.equal(bytes.at(-1), 0xad);
  await conn.request_writable.close();
  responses.close();
});

test("transport failures release request and response stream locks", async () => {
  const failedWriter = {
    current_request: 0,
    request_writable: new WritableStream({
      write() {
        throw new Error("write failed");
      },
    }),
    request_response_readable: new ReadableStream(),
  };
  await assert.rejects(rpcModule.call_rpc(failedWriter, {}), /write failed/);
  assert.equal(failedWriter.request_writable.locked, false);
  const failedReader = {
    current_request: 0,
    request_writable: new WritableStream(),
    request_response_readable: new ReadableStream({
      start(controller) {
        controller.error(new Error("read failed"));
      },
    }),
  };
  await assert.rejects(rpcModule.call_rpc(failedReader, {}), /read failed/);
  assert.equal(failedReader.request_response_readable.locked, false);
});

test("effective custom notifications retain the session-local subsystem and payload", () => {
  const notification = {
    custom: {
      customNotification: {
        subsystemIndex: 9,
        payload: new Uint8Array([1, 2, 3]),
      },
    },
  };
  const result = wire.Response.decode(
    wire.Response.encode({ notification }).finish(),
  );
  assert.deepEqual(
    result.notification.custom.customNotification,
    notification.custom.customNotification,
  );
});

test("discovery uses exact identifiers, not ordinal slot assumptions", async () => {
  const target = device();
  const discovered = await RuntimeClient.discover(target.conn);
  assert.equal(discovered.comboIndex, 9);
  assert.equal(discovered.macroIndex, 7);
  assert.equal(
    (await discovered.snapshot()).macros.definitions[0].name,
    "Greeting",
  );
});

test("omitted combo slots become capacity-derived vacant UI slots", async () => {
  const data = snapshot();
  data.combos.definitions = [comboDefinition(0)];
  const discovered = await device(data).client.snapshot();
  assert.equal(discovered.combos.definitions.length, 2);
  assert.equal(discovered.combos.definitions[1].source, 0);
  assert.deepEqual(discovered.combos.definitions[1].keyPositions, []);
});

test("zero-key disabled combo wire placeholders are not behavior or macro references", () => {
  const data = snapshot();
  data.combos.definitions[1].behavior = { behaviorId: 0, param1: 0, param2: 0 };
  const backup = createStudioBackup(map(), layout, behaviors, "source", data);
  assert.ok(!backup.behaviors.some((item) => item.id === 0));
  assert.doesNotThrow(() =>
    planStudioRestore(backup, map(), layout, behaviors, data),
  );
  assert.equal(model.macroReferences(0, 0, map(), data).length, 0);
});
test("legacy no-response is explicitly unsupported; unrelated errors are not swallowed", async () => {
  const unsupported = connection(async () => ({ meta: { noResponse: true } }));
  const result = await RuntimeClient.discover(unsupported.conn);
  assert.equal(result.comboIndex, undefined);
  assert.deepEqual(await result.snapshot(), {});
  const failed = connection(async () => ({ meta: { simpleError: 1 } }));
  await assert.rejects(RuntimeClient.discover(failed.conn), /Meta error/);
  const missing = connection(async () => ({ meta: { simpleError: 2 } }));
  assert.equal(
    (await RuntimeClient.discover(missing.conn)).macroIndex,
    undefined,
  );
  const generic = connection(async () => ({ meta: { simpleError: 0 } }));
  await assert.rejects(RuntimeClient.discover(generic.conn), /Meta error: 0/);
});
test("custom RPC errors, mismatched subsystem and success-shaped wrong responses reject", async () => {
  const target = device(snapshot(), map(), (kind) => kind === "setTapMs");
  await assert.rejects(
    target.client.macro({ setTapMs: { tapMs: 20, persist: false } }),
    /Injected failure/,
  );
  const wrong = connection(async () => ({
    custom: { call: { subsystemIndex: 8, payload: new Uint8Array() } },
  }));
  await assert.rejects(
    new RuntimeClient(wrong.conn, 9).combo({ listCombos: {} }),
    /mismatched/,
  );
  const shaped = connection(async () => ({
    custom: {
      call: {
        subsystemIndex: 9,
        payload: combo.Response.encode({ listCombos: { combos: [] } }).finish(),
      },
    },
  }));
  await assert.rejects(
    new RuntimeClient(shaped.conn, 9).combo({ save: {} }),
    /expected/,
  );
});
test("legacy zero-ID RPC_NOT_FOUND is accepted only for read-only discovery", async () => {
  const legacy = connection(async () => ({
    requestId: 0,
    meta: { simpleError: 2 },
  }));
  legacy.conn.current_request = 45;
  const discovered = await RuntimeClient.discover(legacy.conn);
  assert.equal(discovered.comboIndex, undefined);
  assert.equal(discovered.macroIndex, undefined);
  for (const request of [
    { core: { getDeviceInfo: true } },
    { keymap: { saveChanges: true } },
    { custom: { call: { subsystemIndex: 9, payload: new Uint8Array() } } },
    { custom: { listCustomSubsystems: {} }, keymap: { saveChanges: true } },
    {
      custom: {
        listCustomSubsystems: {},
        call: { subsystemIndex: 9, payload: new Uint8Array() },
      },
    },
  ]) {
    const unrelated = connection(async () => ({
      requestId: 0,
      meta: { simpleError: 2 },
    }));
    unrelated.conn.current_request = 45;
    await assert.rejects(
      rpcModule.call_rpc(unrelated.conn, request),
      (error) => error === "Mismatch request IDs",
    );
  }
  for (const response of [
    { requestId: 1, meta: { simpleError: 2 } },
    { requestId: 0, meta: { simpleError: 0 } },
    { requestId: 0, meta: { noResponse: true } },
    { requestId: 0, custom: { listCustomSubsystems: { subsystems: [] } } },
  ]) {
    const invalid = connection(async () => response);
    invalid.conn.current_request = 45;
    await assert.rejects(
      RuntimeClient.discover(invalid.conn),
      (error) => error === "Mismatch request IDs",
    );
  }
});
test("lock/disconnect guards prevent writes and reject mid-operation responses", async () => {
  let locked = true;
  const target = connection(async () => {
    locked = true;
    return { custom: { listCustomSubsystems: { subsystems: [] } } };
  });
  const guard = () => {
    if (locked) throw new Error("locked");
  };
  await assert.rejects(RuntimeClient.discover(target.conn, guard), /locked/);
  assert.equal(target.requests.length, 0);
  locked = false;
  const client = new RuntimeClient(target.conn, 9, undefined, guard);
  await assert.rejects(client.combo({ listCombos: {} }), /locked/);
});
test("macro body updates clear first then append ordered typed steps", async () => {
  const target = device();
  const next = definition(1, "Greeting", [
    { down: key() },
    { delay: { delayMs: 125 } },
    { up: key() },
    { tap: key(5) },
  ]);
  await target.client.putMacro(next);
  assert.deepEqual(clean(target.state.macros.definitions[0].steps), next.steps);
  assert.equal(
    target.events.filter((kind) => kind === "appendMacroStep").length,
    4,
  );
  assert.ok(
    target.events.indexOf("setMacroStepCount") <
      target.events.indexOf("appendMacroStep"),
  );
  const bad = definition(6, "Greeting");
  await assert.rejects(target.client.putMacro(bad), /identity/);
});
test("runtime save/discard call all discovered subsystems explicitly", async () => {
  const target = device();
  await target.client.save();
  await target.client.discard();
  assert.deepEqual(target.events, [
    "saveMacros",
    "save",
    "discard",
    "discardMacros",
  ]);
});

test("full save persists macro targets before combo/keymap references", async () => {
  const target = device();
  await target.client.saveKeymap();
  assert.deepEqual(target.events, ["saveMacros", "save", "keymap.saveChanges"]);
  for (const failed of ["saveMacros", "save", "keymap.saveChanges"]) {
    const partial = device(snapshot(), map(), (kind) => kind === failed);
    await assert.rejects(
      partial.client.saveKeymap(),
      /Injected failure|Keymap save failed/,
    );
    assert.deepEqual(
      partial.events,
      target.events.slice(0, target.events.indexOf(failed) + 1),
    );
  }
});

test("full discard removes keymap/combo references before unsaved macros", async () => {
  const target = device();
  await target.client.discardKeymap();
  assert.deepEqual(target.events, [
    "keymap.discardChanges",
    "discard",
    "discardMacros",
  ]);
  for (const failed of target.events) {
    const partial = device(snapshot(), map(), (kind) => kind === failed);
    await assert.rejects(
      partial.client.discardKeymap(),
      /Injected failure|Keymap discard failed/,
    );
    assert.deepEqual(
      partial.events,
      target.events.slice(0, target.events.indexOf(failed) + 1),
    );
  }
});

test("full lifecycle retains legacy keymap support without runtime subsystems", async () => {
  const target = device({});
  await target.client.saveKeymap();
  await target.client.discardKeymap();
  assert.deepEqual(target.events, [
    "keymap.saveChanges",
    "keymap.discardChanges",
  ]);
});

test("macro lifecycle requests preserve names, discovered slots and explicit memory mode", async () => {
  const target = device();
  await target.client.macro({ createMacro: { name: "Fresh", persist: false } });
  let fresh = (await target.client.snapshot()).macros.definitions.find(
    (item) => item.name === "Fresh",
  );
  assert.equal(fresh.slot, 0);
  await target.client.putMacro({ ...fresh, steps: [{ tap: key(6) }] });
  await target.client.macro({
    renameMacro: { oldName: "Fresh", newName: "Renamed", persist: false },
  });
  fresh = (await target.client.snapshot()).macros.definitions.find(
    (item) => item.name === "Renamed",
  );
  assert.equal(fresh.slot, 0);
  assert.equal(fresh.steps[0].tap.param1, key(6).param1);
  await target.client.macro({ deleteMacro: { name: "Renamed" } });
  assert.ok(
    !(await target.client.snapshot()).macros.definitions.some(
      (item) => item.name === "Renamed",
    ),
  );
  await target.client.macro({
    createMacro: { name: "Resettable", persist: false },
  });
  const resettable = (await target.client.snapshot()).macros.definitions.find(
    (item) => item.name === "Resettable",
  );
  await target.client.macro({
    resetMacro: { slot: resettable.slot, persist: false },
  });
  assert.ok(
    !(await target.client.snapshot()).macros.definitions.some(
      (item) => item.name === "Resettable",
    ),
  );
});
test("combo preflight validates physical positions, timing, behavior, layers and name carrier", () => {
  const valid = comboDefinition();
  model.validateCombo(valid, snapshot(), 2, behaviors, [10]);
  for (const update of [
    { keyPositions: [0, 0] },
    { keyPositions: [0, 2] },
    { keyPositions: [0] },
    { layerMask: 0x100000000 },
    { timeoutMs: 65536 },
    { requirePriorIdleMs: -1 },
    { behavior: { ...key(), param2: 5 } },
    { name: "x".repeat(64) },
    { slowReleaseOverride: 5 },
  ])
    assert.throws(() =>
      model.validateCombo(
        { ...valid, ...update },
        snapshot(),
        2,
        behaviors,
        [10],
      ),
    );
});
test("combo preflight retains inactive layer-index bits within the 32-bit mask", () => {
  for (const layerMask of [63, 0x80000000, 0xffffffff])
    model.validateCombo(
      { ...comboDefinition(), layerMask },
      snapshot(),
      2,
      behaviors,
      [10],
    );
});
test("combo overlap warnings honor disabled definitions and disjoint layer masks", () => {
  const primary = { ...comboDefinition(0), layerMask: 1 };
  assert.deepEqual(model.comboOverlaps(primary, [comboDefinition(1)]), [
    "Two key combo",
  ]);
  assert.deepEqual(
    model.comboOverlaps(primary, [
      { ...comboDefinition(1), layerMask: 2 },
      { ...comboDefinition(2), enabled: false },
    ]),
    [],
  );
});
test("macro validation enforces exact compact sizes, shared pool, names and playback queue", () => {
  assert.equal(
    model.macroEncodedSize([{ tap: key() }, { delay: { delayMs: 128 } }]),
    10,
  );
  model.validateMacro(definition(), snapshot(), behaviors, [10]);
  for (const entry of [
    definition(1, ""),
    definition(1, "bad/name"),
    definition(1, "x".repeat(25)),
    definition(1, "Greeting", [{}]),
    definition(1, "Greeting", [{ tap: key(), up: key() }]),
    definition(1, "Greeting", [{ delay: { delayMs: -1 } }]),
    definition(
      1,
      "Greeting",
      Array.from({ length: 65 }, () => ({ delay: { delayMs: 0 } })),
    ),
    definition(1, "Greeting", [
      { keyTapSequence: { packedKeys: new Uint8Array([0]) } },
    ]),
  ])
    assert.throws(() =>
      model.validateMacro(entry, snapshot(), behaviors, [10]),
    );
  const constrained = snapshot();
  constrained.macros.settings.poolBytesTotal = 8;
  assert.throws(
    () => model.validateMacro(definition(), constrained, behaviors),
    /RAM pool/,
  );
});
test("text shortcut produces ordered US-layout key taps and rejects non-ASCII", () => {
  const steps = model.textSteps("aA0!\n", 1);
  assert.equal(steps.length, 5);
  assert.equal(steps[0].tap.param1, (7 << 16) | 4);
  assert.equal(steps[1].tap.param1, (2 << 24) | (7 << 16) | 4);
  assert.equal(steps[2].tap.param1, (7 << 16) | 39);
  assert.equal(steps[4].tap.param1, (7 << 16) | 40);
  assert.throws(() => model.textSteps("é", 1), /US keyboard ASCII/);
});
test("macro references include keys, disabled combos and nested step actions", () => {
  const data = snapshot();
  data.macros.definitions.push(
    definition(2, "Nested", [{ down: macroBinding(1) }]),
  );
  const refs = model.macroReferences(1, 2, map(macroBinding(1)), data);
  assert.equal(refs.length, 3);
  assert.match(refs.join(";"), /Base.*combo.*Nested/);
});
test("version 2 full backup parses definitions and compact bytes; version 1 remains accepted", () => {
  const data = snapshot();
  data.macros.definitions[0].steps = [
    { keyTapSequence: { packedKeys: new Uint8Array([4, 0x85]) } },
  ];
  const backup = createStudioBackup(
    map(macroBinding(1)),
    layout,
    behaviors,
    "source",
    data,
  );
  const parsed = parseKeymapBackup(JSON.stringify(studioBackupJSON(backup)));
  assert.equal(parsed.version, 2);
  assert.deepEqual(
    parsed.runtime.macros.definitions[0].steps,
    data.macros.definitions[0].steps,
  );
  assert.equal(
    parseKeymapBackup(
      JSON.stringify(createKeymapBackup(map(), layout, behaviors, "old")),
    ).version,
    1,
  );
});
test("malformed runtime backup rejects before mutation instead of protobuf defaulting", () => {
  const value = studioBackupJSON(
    createStudioBackup(map(), layout, behaviors, "source", snapshot()),
  );
  for (const mutate of [
    (data) => {
      data.runtime.macros.definitions[0].steps = [
        { tap: { behaviorId: "1", param1: 0, param2: 0 } },
      ];
    },
    (data) => {
      data.runtime.macros.definitions.push(data.runtime.macros.definitions[0]);
    },
    (data) => {
      data.runtime.combos.definitions[0].enabled = "yes";
    },
    (data) => {
      delete data.runtime.physicalKeys;
    },
    (data) => {
      data.runtime.macros.definitions[0].steps = [
        { keyTapSequence: { packedKeys: [256] } },
      ];
    },
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    assert.throws(() => parseKeymapBackup(JSON.stringify(changed)));
  }
});
test("restore remaps cross-device macro slots by name in key and combo bindings", () => {
  const source = createStudioBackup(
    map(macroBinding(5)),
    layout,
    behaviors,
    "different-device",
    snapshot(5),
  );
  const plan = planStudioRestore(source, map(), layout, behaviors, snapshot(1));
  assert.equal(plan.backup.layers[0].bindings[0].param1, 1);
  assert.equal(plan.definitions.combos.definitions[0].behavior.param1, 1);
  assert.equal(plan.definitions.macros.definitions[0].slot, 1);
});
test("restore remaps behavior IDs by unambiguous names rather than device-local IDs", () => {
  const source = createStudioBackup(
    map(macroBinding(5)),
    layout,
    behaviors,
    "source",
    snapshot(5),
  );
  const targetBehaviors = Object.fromEntries(
    Object.values(behaviors).map((item) => [
      item.id + 20,
      { ...item, id: item.id + 20 },
    ]),
  );
  const target = snapshot(1);
  target.macros.settings.keyPressBehaviorId = 21;
  target.combos.definitions[0].behavior.behaviorId = 22;
  target.macros.definitions[0].steps[0].tap.behaviorId = 21;
  const plan = planStudioRestore(
    source,
    map({ behaviorId: 21, param1: key().param1, param2: 0 }),
    layout,
    targetBehaviors,
    target,
  );
  assert.equal(plan.backup.layers[0].bindings[0].behaviorId, 22);
  assert.equal(
    plan.definitions.macros.definitions[0].steps[0].tap.behaviorId,
    21,
  );
  assert.equal(plan.definitions.combos.definitions[0].behavior.behaviorId, 22);
});
test("preflight blocks incompatible geometry, unsupported firmware and destructive exact restore", () => {
  const source = createStudioBackup(
    map(),
    layout,
    behaviors,
    "source",
    snapshot(),
  );
  const wrongLayout = structuredClone(layout);
  wrongLayout.keys[0].x = 1;
  assert.throws(
    () => planStudioRestore(source, map(), wrongLayout, behaviors, snapshot()),
    /geometry/,
  );
  assert.throws(
    () => planStudioRestore(source, map(), layout, behaviors, {}),
    /support/,
  );
  const extra = snapshot();
  extra.macros.definitions.push(definition(2, "Target only"));
  assert.throws(
    () => planStudioRestore(source, map(), layout, behaviors, extra),
    /Target only/,
  );
  const missingReference = structuredClone(source);
  missingReference.layers[0].bindings[0] = macroBinding(7);
  assert.throws(
    () =>
      planStudioRestore(missingReference, map(), layout, behaviors, snapshot()),
    /no named runtime/,
  );
});
test("preflight blocks name/body/pool/slot capacities and dangling free-slot reuse", () => {
  const source = createStudioBackup(
    map(macroBinding(1)),
    layout,
    behaviors,
    "source",
    snapshot(),
  );
  const limited = snapshot();
  limited.macros.maxBytes = 1;
  assert.throws(
    () => planStudioRestore(source, map(), layout, behaviors, limited),
    /body/,
  );
  const pool = snapshot();
  pool.macros.settings.poolBytesTotal = 8;
  assert.throws(
    () => planStudioRestore(source, map(), layout, behaviors, pool),
    /shared RAM/,
  );
  const empty = snapshot();
  empty.macros.definitions = [];
  empty.combos.definitions[0].behavior = key();
  assert.throws(
    () =>
      planStudioRestore(source, map(macroBinding(0)), layout, behaviors, empty),
    /dangling/,
  );
});
test("legacy backups cannot silently reuse raw runtime macro slots", () => {
  const source = createKeymapBackup(
    map(macroBinding(1)),
    layout,
    behaviors,
    "old",
  );
  assert.throws(
    () => planStudioRestore(source, map(), layout, behaviors, snapshot()),
    /Version 1/,
  );
});
test("successful full restore is memory-only and journal undo restores prior effective definitions", async () => {
  const target = device();
  const before = structuredClone(target.state);
  const source = snapshot(5);
  source.macros.definitions[0].steps = [
    { tap: key(6) },
    { delay: { delayMs: 90 } },
  ];
  source.combos.definitions[0].timeoutMs = 120;
  const backup = createStudioBackup(
    map(macroBinding(5)),
    layout,
    behaviors,
    "source",
    source,
  );
  const result = await applyStudioBackup(
    backup,
    map(),
    layout,
    behaviors,
    target.rpc,
    target.client,
  );
  assert.equal(target.keymap.layers[0].bindings[0].param1, 1);
  assert.equal(target.state.combos.definitions[0].timeoutMs, 120);
  assert.deepEqual(
    clean(target.state.macros.definitions[0].steps),
    source.macros.definitions[0].steps,
  );
  assert.ok(
    !target.events.some((kind) =>
      ["save", "saveMacros", "resetCombo", "deleteMacro"].includes(kind),
    ),
  );
  await result.undo();
  assert.deepEqual(
    clean(target.state.macros.definitions[0].steps),
    before.macros.definitions[0].steps,
  );
  assert.deepEqual(target.keymap, map());
});
test("restore creates free named slots and verifies allocation before binding writes", async () => {
  const initial = snapshot();
  initial.macros.definitions = [];
  initial.combos.definitions[0].behavior = key();
  const target = device(initial);
  const source = createStudioBackup(
    map(macroBinding(5)),
    layout,
    behaviors,
    "source",
    snapshot(5),
  );
  const result = await applyStudioBackup(
    source,
    map(),
    layout,
    behaviors,
    target.rpc,
    target.client,
  );
  assert.equal(target.state.macros.definitions[0].slot, 0);
  assert.equal(result.keymap.layers[0].bindings[0].param1, 0);
  await result.undo();
  assert.equal(target.state.macros.definitions.length, 0);
});
test("RPC failure rolls back prior macro body and does not import key bindings", async () => {
  let failed = false;
  const target = device(snapshot(), map(), (kind) => {
    if (kind === "appendMacroStep" && !failed) {
      failed = true;
      return true;
    }
    return false;
  });
  const before = structuredClone(target.state.macros.definitions[0].steps);
  const source = snapshot();
  source.macros.definitions[0].steps = [{ tap: key(6) }];
  const backup = createStudioBackup(
    map(macroBinding(1)),
    layout,
    behaviors,
    "source",
    source,
  );
  await assert.rejects(
    applyStudioBackup(
      backup,
      map(),
      layout,
      behaviors,
      target.rpc,
      target.client,
    ),
    /rolled back in memory/,
  );
  assert.deepEqual(clean(target.state.macros.definitions[0].steps), before);
  assert.ok(!target.events.some((kind) => kind.startsWith("keymap.")));
});
test("rollback failures produce explicit incomplete warnings, never success results", async () => {
  const target = device(
    snapshot(),
    map(),
    (kind) => kind === "appendMacroStep",
  );
  const backup = createStudioBackup(
    map(),
    layout,
    behaviors,
    "source",
    snapshot(),
  );
  await assert.rejects(
    applyStudioBackup(
      backup,
      map(),
      layout,
      behaviors,
      target.rpc,
      target.client,
    ),
    /Rollback incomplete.*do not Save blindly/,
  );
});

test("unexpected allocation stops before key references and removes only the newly created name", async () => {
  const initial = snapshot();
  initial.macros.definitions = [];
  initial.combos.definitions[0].behavior = key();
  let target;
  target = device(initial, map(), (kind) => {
    if (kind === "createMacro" && !target.state.macros.definitions.length)
      target.state.macros.definitions.push(
        definition(0, "External writer", []),
      );
    return false;
  });
  const backup = createStudioBackup(
    map(macroBinding(5)),
    layout,
    behaviors,
    "source",
    snapshot(5),
  );
  await assert.rejects(
    applyStudioBackup(
      backup,
      map(),
      layout,
      behaviors,
      target.rpc,
      target.client,
    ),
    /different macro slot/,
  );
  assert.deepEqual(
    target.state.macros.definitions.map((item) => item.name),
    ["External writer"],
  );
  assert.ok(!target.events.some((kind) => kind.startsWith("keymap.")));
});

test("invalid restore preflight sends reads only and never mutates firmware", async () => {
  const target = device();
  const backup = createStudioBackup(
    map(),
    layout,
    behaviors,
    "source",
    snapshot(),
  );
  backup.runtime.physicalKeys[0].width = 99;
  await assert.rejects(
    applyStudioBackup(
      backup,
      map(),
      layout,
      behaviors,
      target.rpc,
      target.client,
    ),
    /geometry/,
  );
  assert.ok(
    target.events.every((kind) =>
      [
        "getGlobalSettings",
        "listCombos",
        "getMacroGlobalSettings",
        "listMacros",
        "getMacro",
      ].includes(kind),
    ),
  );
});

test("restore undo cannot erase imported macros after a full or partially failed persistent save", async () => {
  for (const failSave of [false, true]) {
    const initial = snapshot();
    initial.macros.definitions = [];
    initial.combos.definitions[0].behavior = key();
    const target = device(
      initial,
      map(),
      (kind) => failSave && kind === "saveMacros",
    );
    const backup = createStudioBackup(
      map(macroBinding(5)),
      layout,
      behaviors,
      "source",
      snapshot(5),
    );
    const result = await applyStudioBackup(
      backup,
      map(),
      layout,
      behaviors,
      target.rpc,
      target.client,
    );
    if (failSave)
      await assert.rejects(target.client.save(), /Injected failure/);
    else await target.client.save();
    const beforeUndo = target.events.length;
    await assert.rejects(
      result.undo(),
      /crossed a Save\/Discard.*saved slot references dangling/,
    );
    assert.equal(target.events.length, beforeUndo);
    assert.equal(target.state.macros.definitions.length, 1);
  }
});
