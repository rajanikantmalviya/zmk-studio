import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";

export type AvailableDevice = { label: string; id: string };

export async function connectNative(
  command: "serial_connect" | "gatt_connect",
  device: AvailableDevice,
): Promise<RpcTransport> {
  const abortController = new AbortController();
  const { signal } = abortController;
  const unlisteners: UnlistenFn[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let stopped = false;
  let failure: unknown;
  const stop = (error?: unknown) => {
    if (stopped) return;
    stopped = true;
    failure = error;
    for (const unlisten of unlisteners) unlisten();
    if (error !== undefined) controller.error(error);
    else controller.close();
  };
  const readable = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      abortController.abort(reason);
    },
  });
  try {
    // Native events are push-based: enqueue synchronously, without competing
    // async getWriter calls that lose fragments under backpressure.
    unlisteners.push(
      await listen<number[]>("connection_data", ({ payload }) => {
        if (!stopped) controller.enqueue(new Uint8Array(payload));
      }),
    );
    unlisteners.push(
      await listen<string | null>("connection_disconnected", ({ payload }) => {
        stop(payload ? new Error(payload) : undefined);
      }),
    );
    if (!(await invoke(command, device)))
      throw new Error("Failed to connect to the native transport.");
  } catch (error) {
    stop(error);
    throw error;
  }
  signal.addEventListener(
    "abort",
    () => {
      stop(signal.reason);
      void invoke("transport_close").catch((error) =>
        console.error("Could not close native transport", error),
      );
    },
    { once: true },
  );
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      signal.throwIfAborted();
      if (stopped) throw failure ?? new Error("Native transport disconnected.");
      try {
        await invoke("transport_send_data", new Uint8Array(chunk));
      } catch (error) {
        stop(error);
        throw error;
      }
    },
  });
  return { label: device.label, abortController, readable, writable };
}
