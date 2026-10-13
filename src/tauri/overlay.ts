import { invoke } from "@tauri-apps/api/core";
import type { OverlayConfiguration } from "../overlay/model";

export const supportsWindowsOverlay =
  !!window.__TAURI_INTERNALS__ && navigator.userAgent.includes("Windows");

let updates: Promise<void> = Promise.resolve();

export function setOverlayConfiguration(config: OverlayConfiguration | null) {
  // Teardown and updates must stay ordered, including across reconnects.
  const update = () => invoke<void>("keyboard_overlay_set", { config });
  const pending = updates.then(update, update);
  updates = pending;
  return pending;
}

export function getOverlayConfiguration() {
  return invoke<OverlayConfiguration | null>("keyboard_overlay_get");
}

export function getOverlayPressedKeys() {
  return invoke<{ pressed: number[]; sequence: number }>(
    "keyboard_overlay_pressed",
  );
}
