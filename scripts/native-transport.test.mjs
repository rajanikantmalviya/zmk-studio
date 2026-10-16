import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
      entry: fileURLToPath(new URL("../src/tauri/index.ts", import.meta.url)),
      formats: ["es"],
    },
  },
});
const chunk = result[0].output.find((item) => item.type === "chunk");
const { connectNative } = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString("base64")}`
);

function native(t, failure) {
  const previous = globalThis.window;
  const callbacks = new Map();
  const listeners = new Map();
  const calls = [];
  let callbackId = 0;
  let listenerId = 0;
  const emit = (event, payload) => {
    for (const [id, listener] of listeners) {
      if (listener.event === event)
        callbacks.get(listener.handler)({ event, id, payload });
    }
  };
  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback(callback) {
        callbacks.set(++callbackId, callback);
        return callbackId;
      },
      async invoke(command, args) {
        calls.push({ command, args });
        if (failure) {
          const error = failure(command);
          if (error) throw error;
        }
        if (command === "plugin:event|listen") {
          listeners.set(++listenerId, args);
          return listenerId;
        }
        if (command === "plugin:event|unlisten") {
          listeners.delete(args.eventId);
          return;
        }
        if (command === "serial_connect" || command === "gatt_connect") {
          emit("connection_data", [1]);
          return true;
        }
        if (command === "transport_send_data" || command === "transport_close")
          return;
        throw new Error(`Unexpected native command: ${command}`);
      },
    },
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  return { emit, calls, listeners };
}

for (const command of ["serial_connect", "gatt_connect"]) {
  test(`${command} preserves overlapping fragments before the consumer is ready`, async (t) => {
    const fixture = native(t);
    const transport = await connectNative(command, {
      id: "fixture",
      label: "fixture",
    });
    fixture.emit("connection_data", [2, 3]);
    fixture.emit("connection_data", [4, 5]);
    const reader = transport.readable.getReader();
    assert.deepEqual(Array.from((await reader.read()).value), [1]);
    assert.deepEqual(Array.from((await reader.read()).value), [2, 3]);
    assert.deepEqual(Array.from((await reader.read()).value), [4, 5]);
    fixture.emit("connection_disconnected", null);
    assert.equal((await reader.read()).done, true);
    reader.releaseLock();
    const writer = transport.writable.getWriter();
    await assert.rejects(writer.write(new Uint8Array([6])), /disconnected/);
    writer.releaseLock();
    assert.equal(fixture.listeners.size, 0);
    transport.abortController.abort();
  });
}

test("native read and write failures surface to RPC consumers", async (t) => {
  const fixture = native(t, (command) =>
    command === "transport_send_data"
      ? new Error("Injected native write failure")
      : undefined,
  );
  const transport = await connectNative("serial_connect", {
    id: "fixture",
    label: "fixture",
  });
  const reader = transport.readable.getReader();
  await reader.read();
  const writer = transport.writable.getWriter();
  await assert.rejects(
    writer.write(new Uint8Array([2])),
    /native write failure/,
  );
  await assert.rejects(reader.read(), /native write failure/);
  assert.equal(fixture.listeners.size, 0);
  writer.releaseLock();
  reader.releaseLock();
  transport.abortController.abort();
});

test("native disconnect errors reject reads and detach event handlers", async (t) => {
  const fixture = native(t);
  const transport = await connectNative("serial_connect", {
    id: "fixture",
    label: "fixture",
  });
  const reader = transport.readable.getReader();
  await reader.read();
  fixture.emit("connection_disconnected", "Injected native read failure");
  await assert.rejects(reader.read(), /native read failure/);
  assert.equal(fixture.listeners.size, 0);
  reader.releaseLock();
  transport.abortController.abort();
});

test("failed event setup removes already registered listeners", async (t) => {
  let subscriptions = 0;
  const fixture = native(t, (command) =>
    command === "plugin:event|listen" && ++subscriptions === 2
      ? new Error("Injected subscription failure")
      : undefined,
  );
  await assert.rejects(
    connectNative("serial_connect", { id: "fixture", label: "fixture" }),
    /subscription failure/,
  );
  assert.equal(fixture.listeners.size, 0);
  assert.ok(!fixture.calls.some((call) => call.command === "serial_connect"));
});

test("failed native connection detaches listeners without reporting success", async (t) => {
  const fixture = native(t, (command) =>
    command === "serial_connect"
      ? new Error("Injected connection failure")
      : undefined,
  );
  await assert.rejects(
    connectNative("serial_connect", { id: "fixture", label: "fixture" }),
    /connection failure/,
  );
  assert.equal(fixture.listeners.size, 0);
});
