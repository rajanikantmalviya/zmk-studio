import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Use the application's existing bundler to load TypeScript and the RPC client.
const output = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    minify: false,
    lib: {
      entry: fileURLToPath(
        new URL("../src/keyboard/keymapBackup.ts", import.meta.url),
      ),
      formats: ["es"],
    },
  },
});
const chunk = output[0].output.find((item) => item.type === "chunk");
const {
  createKeymapBackup,
  parseKeymapBackup,
  validateKeymapBackup,
  applyKeymapBackup,
} = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

const layout = { name: "Test layout", keys: [{}, {}] };
const behaviors = {
  1: {
    id: 1,
    displayName: "Key Press",
    metadata: [{ param1: [{ range: { min: 0, max: 100 } }], param2: [] }],
  },
  2: {
    id: 2,
    displayName: "Momentary Layer",
    metadata: [{ param1: [{ layerId: {} }], param2: [] }],
  },
  3: { id: 3, displayName: "None", metadata: [] },
  4: {
    id: 4,
    displayName: "Layer Tap",
    metadata: [
      { param1: [{ range: { min: 0, max: 100 } }], param2: [{ layerId: {} }] },
    ],
  },
};
const binding = (param1 = 1) => ({ behaviorId: 1, param1, param2: 0 });
const layer = (id, name = `Layer ${id}`) => ({
  id,
  name,
  bindings: [binding(), binding()],
});
const keymap = () => ({
  layers: [layer(5), layer(9)],
  availableLayers: 2,
  maxLayerNameLength: 16,
});
const backup = (map = keymap()) =>
  createKeymapBackup(map, layout, behaviors, "Test keyboard");

function device(initial = keymap(), failure = () => false) {
  const state = structuredClone(initial);
  const removed = new Map();
  const calls = [];
  let nextId = 20;
  const rpc = async (request) => {
    calls.push(structuredClone(request));
    if (failure(request, calls.length)) return { keymap: {} };
    const command = request.keymap;
    if (command.getKeymap)
      return { keymap: { getKeymap: structuredClone(state) } };
    if (command.moveLayer) {
      const { startIndex, destIndex } = command.moveLayer;
      state.layers.splice(destIndex, 0, state.layers.splice(startIndex, 1)[0]);
      return { keymap: { moveLayer: { ok: structuredClone(state) } } };
    }
    if (command.addLayer) {
      const added = layer(nextId++);
      const index = state.layers.length;
      state.layers.push(added);
      state.availableLayers--;
      return {
        keymap: { addLayer: { ok: { index, layer: structuredClone(added) } } },
      };
    }
    if (command.removeLayer) {
      const [removedLayer] = state.layers.splice(
        command.removeLayer.layerIndex,
        1,
      );
      removed.set(removedLayer.id, removedLayer);
      state.availableLayers++;
      return { keymap: { removeLayer: { ok: {} } } };
    }
    if (command.restoreLayer) {
      const restored = removed.get(command.restoreLayer.layerId);
      assert.ok(restored);
      state.layers.splice(command.restoreLayer.atIndex, 0, restored);
      state.availableLayers--;
      removed.delete(restored.id);
      return { keymap: { restoreLayer: { ok: structuredClone(restored) } } };
    }
    if (command.setLayerProps) {
      const { layerId, name } = command.setLayerProps;
      state.layers.find((l) => l.id === layerId).name = name;
      return { keymap: { setLayerProps: 0 } };
    }
    if (command.setLayerBinding) {
      const {
        layerId,
        keyPosition,
        binding: newBinding,
      } = command.setLayerBinding;
      state.layers.find((l) => l.id === layerId).bindings[keyPosition] =
        newBinding;
      return { keymap: { setLayerBinding: 0 } };
    }
    assert.fail("Unexpected request");
  };
  return { state, calls, rpc };
}

test("export/parse round trip preserves names, bindings and order", () => {
  const original = keymap();
  const exported = backup(original);
  assert.deepEqual(parseKeymapBackup(JSON.stringify(exported)), exported);
  validateKeymapBackup(exported, original, layout, behaviors);
  exported.layers[0].name = "Changed";
  assert.notEqual(original.layers[0].name, "Changed");
});

test("parser rejects malformed/unsupported JSON and duplicate IDs", () => {
  assert.throws(() => parseKeymapBackup("{"));
  for (const edit of [
    (b) => {
      b.version = 2;
    },
    (b) => {
      b.layers = [];
    },
    (b) => {
      b.layers[1].id = b.layers[0].id;
    },
    (b) => {
      b.behaviors.push(b.behaviors[0]);
    },
    (b) => {
      delete b.layers[0].bindings[0].param2;
    },
    ...[-1, 1.5, 0x100000000, "1", null].map((value) => (b) => {
      b.layers[0].bindings[0].param1 = value;
    }),
  ]) {
    const b = backup();
    edit(b);
    assert.throws(() => parseKeymapBackup(JSON.stringify(b)));
  }
});

test("all incompatibilities are rejected before any device mutation", async () => {
  for (const edit of [
    (b) => {
      b.physicalLayout.name = "Different";
    },
    (b) => {
      b.physicalLayout.keyCount = 3;
    },
    (b) => {
      b.layers.push(layer(10), layer(11), layer(12));
    },
    (b) => {
      b.layers[0].name = "Name longer than sixteen";
    },
    (b) => {
      b.layers[0].name = "😀".repeat(5);
    },
    (b) => {
      b.layers[0].bindings.pop();
    },
    (b) => {
      b.layers[0].bindings[0].behaviorId = 999;
    },
    (b) => {
      b.behaviors[0].displayName = "Changed firmware";
    },
    (b) => {
      b.layers[0].bindings[0].param1 = 101;
    },
    (b) => {
      b.layers[0].bindings[0].param2 = 1;
    },
    (b) => {
      b.behaviors.push({ id: 2, displayName: behaviors[2].displayName });
      b.layers[0].bindings[0] = { behaviorId: 2, param1: 999, param2: 0 };
    },
  ]) {
    const b = backup();
    edit(b);
    const d = device();
    await assert.rejects(
      applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
    );
    assert.equal(d.calls.length, 0);
  }
});

test("unchanged import sends no mutations or saves", async () => {
  const d = device();
  const result = await applyKeymapBackup(
    backup(),
    d.state,
    layout,
    behaviors,
    d.rpc,
  );
  assert.deepEqual(result.keymap, keymap());
  assert.deepEqual(d.calls, [{ keymap: { getKeymap: true } }]);
  await result.undo();
  assert.deepEqual(d.state, keymap());
});

test("export rejects behavior details that have not loaded", () => {
  assert.throws(
    () => createKeymapBackup(keymap(), layout, {}, "Test"),
    /has not loaded/,
  );
});

test("unassigned bindings export and round trip without behavior metadata", async () => {
  const original = keymap();
  original.layers[0].bindings[0] = { behaviorId: 0, param1: 0, param2: 0 };
  const b = parseKeymapBackup(JSON.stringify(backup(original)));
  assert.deepEqual(b.layers, original.layers);
  assert.ok(!b.behaviors.some((behavior) => behavior.id === 0));
  b.layers[0].bindings[1] = binding(30);
  const d = device(original);
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.deepEqual(
    d.state.layers[0].bindings[0],
    original.layers[0].bindings[0],
  );
  assert.equal(d.state.layers[0].bindings[1].param1, 30);
  await result.undo();
  assert.deepEqual(d.state, original);
  assert.ok(
    !d.calls.some((r) => r.keymap.setLayerBinding?.binding.behaviorId === 0),
  );
});

test("unassigned positions cannot be introduced, replaced or given parameters", async () => {
  for (const direction of [
    "introduce",
    "replace",
    "param1",
    "param2",
    "new layer",
  ]) {
    const original = keymap();
    const b = backup(original);
    const empty = { behaviorId: 0, param1: 0, param2: 0 };
    if (direction === "introduce") {
      b.layers[0].bindings[0] = empty;
    } else if (direction === "new layer") {
      const added = layer(100);
      added.bindings[0] = empty;
      b.layers.push(added);
    } else {
      original.layers[0].bindings[0] = empty;
      if (direction !== "replace") {
        b.layers[0].bindings[0] = { ...empty, [direction]: 1 };
      }
    }
    const d = device(original);
    await assert.rejects(
      applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
      /unassigned bindings/,
    );
    assert.equal(d.calls.length, 0);
    assert.deepEqual(d.state, original);
  }
});

test("unassigned bindings follow their layer when the backup reorders layers", async () => {
  const original = keymap();
  original.layers[0].bindings[0] = { behaviorId: 0, param1: 0, param2: 0 };
  const b = backup(original);
  b.layers.reverse();
  const d = device(original);
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.equal(d.state.layers[1].id, 5);
  assert.equal(d.state.layers[1].bindings[0].behaviorId, 0);
  await result.undo();
  assert.deepEqual(d.state, original);
});

test("a registered behavior ID zero is validated and exported normally", async () => {
  const registered = {
    ...behaviors,
    0: { ...behaviors[1], id: 0, displayName: "Registered zero" },
  };
  const original = keymap();
  original.layers[0].bindings[0] = { behaviorId: 0, param1: 5, param2: 0 };
  const b = createKeymapBackup(original, layout, registered, "Test");
  assert.ok(b.behaviors.some((behavior) => behavior.id === 0));
  const d = device();
  const result = await applyKeymapBackup(b, d.state, layout, registered, d.rpc);
  assert.equal(d.state.layers[0].bindings[0].param1, 5);
  await result.undo();
  assert.deepEqual(d.state, keymap());
  b.layers[0].bindings[0].param1 = 101;
  assert.throws(() => validateKeymapBackup(b, d.state, layout, registered));
});

test("zero-parameter behaviors and layer ID zero are accepted", async () => {
  const source = keymap();
  source.layers[0].id = 0;
  source.layers[0].bindings[0] = {
    behaviorId: 3,
    param1: 0,
    param2: 0,
  };
  source.layers[1].bindings[0] = {
    behaviorId: 2,
    param1: 0,
    param2: 0,
  };
  const b = backup(source);
  const d = device();
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.equal(d.state.layers[1].bindings[0].param1, 5);
  await result.undo();
  assert.deepEqual(d.state, keymap());
  b.layers[0].bindings[0].param2 = 1;
  assert.throws(() => validateKeymapBackup(b, keymap(), layout, behaviors));
});

test("bulk edits and renames can be undone without losing previous pending edits", async () => {
  const original = keymap();
  original.layers[1].bindings[0] = binding(42);
  const b = backup(original);
  b.layers[0].name = "Base";
  b.layers[0].bindings[0] = binding(50);
  const d = device(original);
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.equal(d.state.layers[0].name, "Base");
  assert.equal(d.state.layers[0].bindings[0].param1, 50);
  assert.deepEqual(result.keymap, d.state);
  await result.undo();
  assert.deepEqual(d.state, original);
  assert.ok(
    !d.calls.some((r) => r.keymap.saveChanges || r.keymap.discardChanges),
  );
});

test("adding layers remaps both layer parameters; undo and reimport work", async () => {
  const source = keymap();
  source.layers.push(layer(100));
  source.layers[0].bindings[0] = { behaviorId: 2, param1: 100, param2: 0 };
  source.layers[0].bindings[1] = { behaviorId: 4, param1: 7, param2: 100 };
  const b = backup(source);
  const d = device();
  for (const expectedId of [20, 21]) {
    const result = await applyKeymapBackup(
      b,
      d.state,
      layout,
      behaviors,
      d.rpc,
    );
    assert.equal(d.state.layers[2].id, expectedId);
    assert.equal(d.state.layers[0].bindings[0].param1, expectedId);
    assert.equal(d.state.layers[0].bindings[1].param2, expectedId);
    await result.undo();
    assert.deepEqual(d.state, keymap());
  }
});

test("removing layers and changing layer order preserve bindings and undo", async () => {
  const b = backup();
  b.layers.reverse();
  b.layers[0].bindings[0] = binding(30);
  b.layers.pop();
  const d = device();
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.equal(d.state.layers.length, 1);
  assert.equal(d.state.layers[0].id, 9);
  assert.equal(d.state.layers[0].name, "Layer 9");
  assert.equal(d.state.layers[0].bindings[0].param1, 30);
  await result.undo();
  assert.deepEqual(d.state, keymap());
});

test("reordered layers retain their IDs and remapped references", async () => {
  const source = keymap();
  source.layers[0].bindings[0] = { behaviorId: 2, param1: 9, param2: 0 };
  const b = backup(source);
  b.layers.reverse();
  const d = device();
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  assert.deepEqual(
    d.state.layers.map((l) => l.id),
    [9, 5],
  );
  assert.equal(d.state.layers[1].bindings[0].param1, 9);
  await result.undo();
  assert.deepEqual(d.state, keymap());
});

test("failed reordered imports restore both order and contents", async () => {
  const b = backup();
  b.layers.reverse();
  b.layers[0].name = "New name";
  b.layers[1].bindings[0] = binding(30);
  for (let failedCall = 1; failedCall <= 4; failedCall++) {
    const d = device(keymap(), (_r, number) => number === failedCall);
    await assert.rejects(
      applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
      /rolled back/,
    );
    assert.deepEqual(d.state, keymap());
  }
});

test("failure at each mutation rolls back acknowledged changes", async () => {
  const b = backup();
  b.layers[0].name = "Base";
  b.layers[0].bindings = [binding(11), binding(12)];
  b.layers[1].name = "Other";
  b.layers.push(layer(100));
  for (let failedCall = 1; failedCall <= 7; failedCall++) {
    const d = device(keymap(), (_r, number) => number === failedCall);
    await assert.rejects(
      applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
      /rolled back/,
    );
    assert.deepEqual(d.state, keymap());
  }
});

test("rollback restores removed layers if final read fails", async () => {
  const b = backup();
  b.layers.pop();
  b.layers[0].name = "Base";
  const d = device(keymap(), (r) => !!r.keymap.getKeymap);
  await assert.rejects(
    applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
    /rolled back/,
  );
  assert.deepEqual(d.state, keymap());
});

test("transport rejection triggers rollback", async () => {
  const b = backup();
  b.layers[0].name = "Base";
  b.layers[0].bindings[0] = binding(10);
  const d = device();
  const rpc = async (request) => {
    if (request.keymap.setLayerBinding) throw new Error("Transport failed");
    return d.rpc(request);
  };
  await assert.rejects(
    applyKeymapBackup(b, d.state, layout, behaviors, rpc),
    /Transport failed.*rolled back/,
  );
  assert.deepEqual(d.state, keymap());
});

test("rollback failure explicitly warns about partial changes", async () => {
  const b = backup();
  b.layers[0].name = "Base";
  b.layers[0].bindings[0] = binding(10);
  const d = device(keymap(), (_r, number) => number >= 2);
  await assert.rejects(
    applyKeymapBackup(b, d.state, layout, behaviors, d.rpc),
    /Rollback also failed.*partial changes/,
  );
});

test("failed undo can retry without repeating completed inverses", async () => {
  const b = backup();
  b.layers.pop();
  b.layers[0].name = "Base";
  let failRename = false;
  const d = device(keymap(), (r) => failRename && !!r.keymap.setLayerProps);
  const result = await applyKeymapBackup(b, d.state, layout, behaviors, d.rpc);
  failRename = true;
  await assert.rejects(result.undo());
  assert.equal(d.state.layers.length, 2);
  failRename = false;
  await result.undo();
  assert.deepEqual(d.state, keymap());
});
