import assert from "node:assert/strict";
import { test } from "node:test";

const browser = process.env.ZMK_VIEWER_TEST_CDP;
const viewerUrl = process.env.ZMK_VIEWER_TEST_URL;

async function connectPage() {
  const response = await fetch(`${browser}/json/new?about:blank`, {
    method: "PUT",
  });
  if (!response.ok)
    throw new Error(`Could not create browser test page: ${response.status}`);
  const target = await response.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timeout);
    message.error
      ? request.reject(new Error(message.error.message))
      : request.resolve(message.result);
  };
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 10000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (expression) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const diagnostic = await evaluate(`({
      text:document.body.innerText,
      fixture:!!window.viewerFixture,
      calls:window.viewerFixture?.native.calls,
    })`);
    throw new Error(
      `Viewer UI condition timed out: ${expression}; ${JSON.stringify(diagnostic)}`,
    );
  };
  return {
    call,
    evaluate,
    waitFor,
    close: async () => {
      socket.close();
      const result = await fetch(`${browser}/json/close/${target.id}`);
      if (!result.ok)
        throw new Error(`Could not close browser test page: ${result.status}`);
    },
  };
}

function fixtureScript() {
  const callbacks = new Map();
  const listeners = new Map();
  let callbackId = 0;
  let listenerId = 0;
  const frames = [
    {
      type: "hello",
      version: 1,
      deviceName: "Viewer UI fixture",
      layoutName: "Six keys",
      defaultLayer: 0,
    },
    ...[0, 1, 2, 3, 4, 5].map((position) => ({
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
      name: "Runtime Macro",
      kind: "runtime-macro",
      children: [],
    },
    {
      type: "layer",
      id: 0,
      name: "Base",
      bindings: [0x7002c, 0x7002a, 0x7002b, 0x70028, 0x70029, 0x7004c].map(
        (usage) => [1, usage, 0],
      ),
    },
    {
      type: "capabilities",
      runtimeCombos: true,
      runtimeMacros: true,
      bleStreaming: true,
    },
    ...Array.from({ length: 30 }, (_, slot) => ({
      type: "combo",
      slot,
      name: `Combo ${slot}`,
      positions: [0, 1],
      layers: [0],
      binding: [2, 0, 0],
      timeoutMs: 50,
      enabled: true,
    })),
    ...Array.from({ length: 20 }, (_, slot) => ({
      type: "macro",
      slot,
      name: `Macro ${slot}`,
      source: "runtime",
      steps: [{ kind: "tap", binding: [1, 0x70004, 0] }],
    })),
    { type: "ready" },
  ];
  const native = {
    visible: true,
    focused: false,
    interactive: false,
    calls: [],
  };
  const emit = (event, payload) => {
    for (const [id, listener] of listeners) {
      if (listener.event === event)
        callbacks.get(listener.handler)?.({ event, id, payload });
    }
  };
  const metadata = {
    currentWindow: { label: "main" },
    currentWebview: { label: "main" },
  };
  window.__TAURI_INTERNALS__ = {
    metadata,
    getMetadata: () => metadata,
    transformCallback: (callback) => {
      const id = ++callbackId;
      callbacks.set(id, callback);
      return id;
    },
    invoke: async (command, args) => {
      native.calls.push({ command, args });
      switch (command) {
        case "serial_list_devices":
          return [{ id: "FIXTURE", label: "Fixture USB" }];
        case "viewer_ble_list_devices":
          return [{ id: "FIXTURE-BLE", label: "Fixture Bluetooth" }];
        case "viewer_connect":
          if (window.viewerFixture.earlyConfiguration) {
            const refreshed = structuredClone(frames);
            refreshed.find(
              (frame) => frame.type === "macro" && frame.slot === 0,
            ).name = "Early macro";
            emit("viewer-configuration", {
              connectionId: 42,
              frames: refreshed,
              initialState: {
                type: "state",
                sequence: 2,
                pressed: [],
                released: [],
                layers: [0],
              },
            });
          }
          return {
            connectionId: 42,
            frames,
            initialState: {
              type: "state",
              sequence: 1,
              pressed: [],
              released: [],
              layers: [0],
            },
          };
        case "viewer_disconnect":
          return;
        case "viewer_set_overlay":
          native.interactive = args.enabled && args.interactive;
          native.focused = native.interactive;
          if (native.interactive) native.visible = true;
          return;
        case "viewer_toggle_display":
          native.visible = !native.visible;
          if (native.visible) emit("viewer-display", null);
          else emit("viewer-hidden", null);
          return;
        case "plugin:event|listen": {
          const id = ++listenerId;
          listeners.set(id, args);
          return id;
        }
        case "plugin:event|unlisten":
          listeners.delete(args.eventId);
          return;
        case "plugin:window|close":
          native.visible = false;
          emit("viewer-hidden", null);
          return;
        case "plugin:window|set_always_on_top":
          return;
        default:
          throw new Error(`Unexpected test native command: ${command}`);
      }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.viewerFixture = {
    native,
    frames,
    emit,
    state: (positions) =>
      emit("viewer-state", {
        connectionId: 42,
        state: {
          type: "state",
          sequence: 2,
          pressed: positions.map((position) => [position, 0]),
          released: [],
          layers: [0],
        },
      }),
  };
}

test(
  "viewer places shifted legends in the upper-right without replacing tap or hold labels",
  { skip: !browser || !viewerUrl, timeout: 30000 },
  async () => {
    const page = await connectPage();
    try {
      await page.call("Page.enable");
      await page.call("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${fixtureScript.toString()})()`,
      });
      await page.call("Page.navigate", { url: viewerUrl });
      await page.waitFor(
        `document.querySelector('select[aria-label="Viewer USB port"]')?.value === 'FIXTURE'`,
      );
      await page.evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent === 'Connect').click()`,
      );
      await page.waitFor(`document.querySelector('.viewer-keyboard')`);
      assert.equal(
        await page.evaluate(`document.querySelectorAll('.key-shift').length`),
        0,
      );
      await page.evaluate(`(() => {
        const frames = structuredClone(viewerFixture.frames);
        frames.splice(-1, 0, {
          type:'behavior', id:3, name:'Home Row Mod', kind:'hold-tap',
          children:[[1,0,0],[1,0,0]],
        });
        frames.find(frame => frame.type === 'layer').bindings = [
          [3,0x700e1,0x7001e], [1,0x70038,0], [1,0x70004,0],
          [1,0x70027,0], [1,0x70050,0], [2,0,0],
        ];
        viewerFixture.emit('viewer-configuration', {
          connectionId:42, frames,
          initialState:{type:'state',sequence:3,pressed:[],released:[],layers:[0]},
        });
      })()`);
      await page.waitFor(
        `document.querySelectorAll('.key-shift').length === 4`,
      );
      const legends = await page.evaluate(`(() => {
        const keys = [...document.querySelectorAll('.viewer-keyboard > g')];
        return {
          shifted: keys.map(key => key.querySelector('.key-shift')?.textContent ?? null),
          hold: keys[0].querySelector('.key-hold').textContent,
          tap: keys[0].querySelector('.key-tap').textContent,
          title: keys[0].querySelector('title').textContent,
          corners: keys.filter(key => key.querySelector('.key-shift')).every(key => {
            const rect = key.querySelector('rect').getBBox();
            const legend = key.querySelector('.key-shift');
            const box = legend.getBBox();
            return getComputedStyle(legend).textAnchor === 'end' &&
              box.x >= rect.x + rect.width / 2 &&
              box.x + box.width <= rect.x + rect.width &&
              box.y >= rect.y && box.y + box.height < rect.y + rect.height / 2;
          }),
        };
      })()`);
      assert.deepEqual(legends.shifted, ["!", "?", "A", ")", null, null]);
      assert.equal(legends.hold, "Lshft");
      assert.equal(legends.tap, "1");
      assert.match(legends.title, /Shift \(US\): !/);
      assert.equal(legends.corners, true);
      assert.equal(
        await page.evaluate(
          `document.querySelector('[role="alert"]')?.textContent`,
        ),
        undefined,
      );
    } finally {
      await page.close();
    }
  },
);

test(
  "viewer UI lists are interactive, scrollable, exclusive and refreshed by firmware",
  {
    skip: !browser || !viewerUrl,
    timeout: 60000,
  },
  async () => {
    const page = await connectPage();
    try {
      await page.call("Page.enable");
      await page.call("Page.addScriptToEvaluateOnNewDocument", {
        source: `(${fixtureScript.toString()})()`,
      });
      await page.call("Page.navigate", { url: viewerUrl });
      await page.waitFor(
        `document.querySelector('select[aria-label="Viewer USB port"]')?.value === 'FIXTURE'`,
      );
      await page.evaluate(
        `viewerFixture.earlyConfiguration = true; [...document.querySelectorAll('button')].find(button => button.textContent === 'Connect').click()`,
      );
      await page.waitFor(
        `document.querySelector('main')?.classList.contains('typing-overlay')`,
      );
      await page.evaluate(`viewerFixture.state([2,3])`);
      await page.waitFor(
        `viewerFixture.native.interactive && document.querySelector('[aria-label="Firmware combos"]')`,
      );
      assert.equal(await page.evaluate(`viewerFixture.native.focused`), true);
      assert.equal(
        await page.evaluate(`(() => {
      const panel = document.querySelector('[aria-label="Firmware combos"]');
      panel.scrollTop = 100;
      return panel.scrollHeight > panel.clientHeight && panel.scrollTop > 0;
    })()`),
        true,
      );
      await page.evaluate(`viewerFixture.state([2,3])`);
      assert.equal(
        await page.evaluate(
          `document.querySelector('[aria-label="Firmware combos"]') !== null`,
        ),
        true,
      );
      await page.evaluate(
        `viewerFixture.state([]); viewerFixture.state([4,5])`,
      );
      await page.waitFor(
        `document.querySelector('[aria-label="Firmware macros"]') && !document.querySelector('[aria-label="Firmware combos"]')`,
      );
      assert.equal(
        await page.evaluate(
          `document.querySelector('[aria-label="Firmware macros"]').textContent.includes('Early macro')`,
        ),
        true,
      );
      assert.equal(await page.evaluate(`viewerFixture.native.focused`), true);
      assert.equal(
        await page.evaluate(`(() => {
      const panel = document.querySelector('[aria-label="Firmware macros"]');
      panel.scrollTop = 100;
      return panel.scrollHeight > panel.clientHeight && panel.scrollTop > 0;
    })()`),
        true,
      );
      await page.evaluate(`(() => {
      const frames = structuredClone(viewerFixture.frames);
      frames.find(frame => frame.type === 'macro' && frame.slot === 0).name = 'Updated macro';
      viewerFixture.emit('viewer-configuration', {
        connectionId:42, frames,
        initialState:{type:'state',sequence:3,pressed:[],released:[],layers:[0]},
      });
    })()`);
      await page.waitFor(
        `document.querySelector('[aria-label="Firmware macros"]').textContent.includes('Updated macro')`,
      );
      await page.evaluate(
        `document.querySelector('[aria-label="Close macro list"]').click()`,
      );
      await page.waitFor(
        `!viewerFixture.native.interactive && !viewerFixture.native.focused`,
      );
      assert.equal(
        await page.evaluate(
          `document.querySelector('[aria-label="Firmware macros"]') === null`,
        ),
        true,
      );
      await page.evaluate(
        `viewerFixture.state([]); viewerFixture.state([2,3])`,
      );
      await page.waitFor(
        `viewerFixture.native.interactive && document.querySelector('[aria-label="Firmware combos"]')`,
      );
      await page.evaluate(
        `document.querySelector('[aria-label="Close viewer"]').click()`,
      );
      await page.waitFor(
        `!viewerFixture.native.visible && !document.querySelector('[aria-label="Firmware combos"]')`,
      );
      await page.evaluate(
        `viewerFixture.state([]); viewerFixture.state([2,3])`,
      );
      await page.waitFor(
        `viewerFixture.native.visible && viewerFixture.native.interactive && document.querySelector('[aria-label="Firmware combos"]')`,
      );
      await page.evaluate(
        `viewerFixture.state([]); viewerFixture.state([0,1])`,
      );
      await page.waitFor(
        `!viewerFixture.native.visible && !viewerFixture.native.interactive`,
      );
      await page.evaluate(
        `viewerFixture.state([]); viewerFixture.state([0,1])`,
      );
      await page.waitFor(`viewerFixture.native.visible`);
      assert.equal(
        await page.evaluate(
          `document.querySelector('[role="alert"]')?.textContent`,
        ),
        undefined,
      );
    } finally {
      await page.close();
    }
  },
);
