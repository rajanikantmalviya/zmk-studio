import { invoke } from "@tauri-apps/api/core";
import type { RpcTransport } from "@zmkfirmware/zmk-studio-ts-client/transport/index";
import { AvailableDevice, connectNative } from ".";

export async function list_devices(): Promise<Array<AvailableDevice>> {
  return await invoke("serial_list_devices");
}

export async function connect(dev: AvailableDevice): Promise<RpcTransport> {
  return connectNative("serial_connect", dev);
}
