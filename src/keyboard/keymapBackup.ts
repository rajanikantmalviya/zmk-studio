import type {
  Request,
  RequestResponse,
} from "@zmkfirmware/zmk-studio-ts-client";
import type {
  BehaviorParameterValueDescription,
  GetBehaviorDetailsResponse,
} from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import {
  BehaviorBinding,
  Keymap,
  Layer,
  PhysicalLayout,
  SetLayerBindingResponse,
  SetLayerPropsResponse,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { validateValue } from "../behaviors/parameters";
import { parseRuntimeBackup, RuntimeBackup } from "../runtime/backupSchema";

export type BehaviorMap = Record<number, GetBehaviorDetailsResponse>;
export type KeymapRpc = (
  request: Omit<Request, "requestId">,
) => Promise<RequestResponse>;

export interface KeymapBackup {
  format: "zmk-studio-keymap";
  version: 1 | 2;
  deviceName: string;
  physicalLayout: { name: string; keyCount: number };
  behaviors: { id: number; displayName: string }[];
  layers: Layer[];
  runtime?: RuntimeBackup;
}

export function createKeymapBackup(
  keymap: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
  deviceName: string,
): KeymapBackup {
  const ids = new Set(
    keymap.layers.flatMap((layer) => layer.bindings.map((b) => b.behaviorId)),
  );
  return {
    format: "zmk-studio-keymap",
    version: 1,
    deviceName,
    physicalLayout: { name: layout.name, keyCount: layout.keys.length },
    behaviors: [...ids]
      .filter((id) => id !== 0 || behaviors[id])
      .map((id) => {
        if (!behaviors[id]) {
          throw new Error(`Behavior ${id} has not loaded. Try again shortly.`);
        }
        return { id, displayName: behaviors[id].displayName };
      }),
    layers: structuredClone(keymap.layers),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uint32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}

export function parseKeymapBackup(text: string): KeymapBackup {
  const value: unknown = JSON.parse(text);
  if (
    !record(value) ||
    value.format !== "zmk-studio-keymap" ||
    (value.version !== 1 && value.version !== 2)
  ) {
    throw new Error(
      "Expected a ZMK Studio keymap JSON backup (version 1 or 2).",
    );
  }
  if (
    typeof value.deviceName !== "string" ||
    !record(value.physicalLayout) ||
    typeof value.physicalLayout.name !== "string" ||
    !uint32(value.physicalLayout.keyCount) ||
    !Array.isArray(value.behaviors) ||
    !Array.isArray(value.layers) ||
    value.layers.length === 0
  ) {
    throw new Error("Invalid backup: device, physical layout, or layers.");
  }
  const behaviors = value.behaviors.map((behavior: unknown) => {
    if (
      !record(behavior) ||
      !uint32(behavior.id) ||
      typeof behavior.displayName !== "string"
    ) {
      throw new Error("Invalid behavior in backup.");
    }
    return { id: behavior.id, displayName: behavior.displayName };
  });
  const layers = value.layers.map((layer: unknown, index: number): Layer => {
    if (
      !record(layer) ||
      !uint32(layer.id) ||
      typeof layer.name !== "string" ||
      !Array.isArray(layer.bindings)
    ) {
      throw new Error(`Invalid layer ${index + 1}.`);
    }
    const bindings = layer.bindings.map(
      (binding: unknown, position: number): BehaviorBinding => {
        if (
          !record(binding) ||
          !uint32(binding.behaviorId) ||
          !uint32(binding.param1) ||
          !uint32(binding.param2)
        ) {
          throw new Error(
            `Invalid binding at layer ${index + 1}, key ${position + 1}: ` +
              "behaviorId, param1 and param2 must be unsigned 32-bit integers.",
          );
        }
        return {
          behaviorId: binding.behaviorId,
          param1: binding.param1,
          param2: binding.param2,
        };
      },
    );
    return { id: layer.id, name: layer.name, bindings };
  });
  if (
    new Set(layers.map((l) => l.id)).size !== layers.length ||
    new Set(behaviors.map((b) => b.id)).size !== behaviors.length
  ) {
    throw new Error("Layer IDs and behavior IDs must be unique.");
  }
  return {
    format: "zmk-studio-keymap",
    version: value.version,
    deviceName: value.deviceName,
    physicalLayout: {
      name: value.physicalLayout.name,
      keyCount: value.physicalLayout.keyCount,
    },
    behaviors,
    layers,
    ...(value.version === 2
      ? { runtime: parseRuntimeBackup(value.runtime) }
      : {}),
  };
}

function parameterSet(
  binding: BehaviorBinding,
  behavior: GetBehaviorDetailsResponse | undefined,
  layerIds: number[],
) {
  return behavior?.metadata.find(
    (set) =>
      validateValue(layerIds, binding.param1, set.param1) &&
      validateValue(layerIds, binding.param2, set.param2),
  );
}

export function selectTargetLayers(sources: Layer[], targets: Layer[]) {
  const reservedIds = new Set(
    sources
      .filter((source) => targets.some((l) => l.id === source.id))
      .map((source) => source.id),
  );
  const assignedIds = new Set<number>();
  return sources.map((source) => {
    const target =
      targets.find((l) => l.id === source.id) ??
      targets.find((l) => !reservedIds.has(l.id) && !assignedIds.has(l.id));
    if (target) assignedIds.add(target.id);
    return target;
  });
}

function validateUnassignedBindings(
  source: Layer,
  target: Layer | undefined,
  behaviors: BehaviorMap,
  layerIndex: number,
) {
  if (behaviors[0]) return;
  for (const [position, binding] of source.bindings.entries()) {
    const old = target?.bindings[position];
    if (binding.behaviorId !== 0 && old?.behaviorId !== 0) continue;
    if (
      binding.behaviorId === 0 &&
      old?.behaviorId === 0 &&
      binding.param1 === 0 &&
      binding.param2 === 0 &&
      old.param1 === 0 &&
      old.param2 === 0
    ) {
      continue;
    }
    throw new Error(
      `Layer ${layerIndex + 1}, key ${position + 1}: unassigned bindings ` +
        "cannot be written or restored through this firmware's Studio API. " +
        "Keep this position unchanged.",
    );
  }
}

export function validateKeymapBackup(
  backup: KeymapBackup,
  keymap: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
): void {
  if (
    backup.physicalLayout.name !== layout.name ||
    backup.physicalLayout.keyCount !== layout.keys.length
  ) {
    throw new Error(
      `Select the backup's physical layout "${backup.physicalLayout.name}" before importing.`,
    );
  }
  if (backup.layers.length > keymap.layers.length + keymap.availableLayers) {
    throw new Error("The backup has more layers than this firmware supports.");
  }
  const exportedBehaviors = new Map(backup.behaviors.map((b) => [b.id, b]));
  const layerIds = backup.layers.map((l) => l.id);
  const targets = selectTargetLayers(backup.layers, keymap.layers);
  for (const [index, layer] of backup.layers.entries()) {
    if (
      new TextEncoder().encode(layer.name).length > keymap.maxLayerNameLength
    ) {
      throw new Error(
        `Layer ${index + 1}'s name exceeds the firmware's limit.`,
      );
    }
    const expectedCount =
      targets[index]?.bindings.length ?? keymap.layers[0].bindings.length;
    if (layer.bindings.length !== expectedCount) {
      throw new Error(`Layer ${index + 1} has an incompatible key count.`);
    }
    validateUnassignedBindings(layer, targets[index], behaviors, index);
    for (const [position, binding] of layer.bindings.entries()) {
      const behavior = behaviors[binding.behaviorId];
      if (binding.behaviorId === 0 && !behavior) continue;
      if (
        !behavior ||
        exportedBehaviors.get(binding.behaviorId)?.displayName !==
          behavior.displayName
      ) {
        throw new Error(
          `Layer ${index + 1}, key ${position + 1}: behavior ${binding.behaviorId} ` +
            "does not match this firmware. Use a backup from compatible firmware.",
        );
      }
      if (
        !parameterSet(binding, behavior, layerIds) &&
        !(
          behavior.metadata.length === 0 &&
          binding.param1 === 0 &&
          binding.param2 === 0
        )
      ) {
        throw new Error(
          `Layer ${index + 1}, key ${position + 1}: invalid behavior parameters.`,
        );
      }
    }
  }
}

function remapParameter(
  value: number,
  descriptions: BehaviorParameterValueDescription[] | undefined,
  sourceIds: number[],
  targetIds: number[],
) {
  const matching = descriptions?.find((description) =>
    validateValue(sourceIds, value, [description]),
  );
  return matching?.layerId ? targetIds[sourceIds.indexOf(value)] : value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Each acknowledged mutation records its inverse. Never discardChanges here:
 * that would also discard unrelated edits made before importing.
 */
export async function applyKeymapBackup(
  backup: KeymapBackup,
  current: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
  rpc: KeymapRpc,
): Promise<{ keymap: Keymap; undo: () => Promise<void> }> {
  validateKeymapBackup(backup, current, layout, behaviors);
  const layers = structuredClone(current.layers);
  const inverses: (() => Promise<void>)[] = [];

  const setName = async (layerId: number, name: string) => {
    const response = await rpc({
      keymap: { setLayerProps: { layerId, name } },
    });
    if (
      response.keymap?.setLayerProps !==
      SetLayerPropsResponse.SET_LAYER_PROPS_RESP_OK
    ) {
      throw new Error(`Could not rename layer ${layerId}.`);
    }
  };
  const setBinding = async (
    layerId: number,
    keyPosition: number,
    binding: BehaviorBinding,
  ) => {
    const response = await rpc({
      keymap: { setLayerBinding: { layerId, keyPosition, binding } },
    });
    if (
      response.keymap?.setLayerBinding !==
      SetLayerBindingResponse.SET_LAYER_BINDING_RESP_OK
    ) {
      throw new Error(
        `Could not update layer ${layerId}, key ${keyPosition + 1}.`,
      );
    }
  };
  const remove = async (layerIndex: number) => {
    const response = await rpc({ keymap: { removeLayer: { layerIndex } } });
    if (!response.keymap?.removeLayer?.ok) {
      throw new Error(`Could not remove layer ${layerIndex + 1}.`);
    }
  };
  const move = async (startIndex: number, destIndex: number) => {
    const response = await rpc({
      keymap: { moveLayer: { startIndex, destIndex } },
    });
    if (!response.keymap?.moveLayer?.ok) {
      throw new Error(`Could not move layer ${startIndex + 1}.`);
    }
  };
  const rollback = async () => {
    while (inverses.length > 0) {
      await inverses[inverses.length - 1]();
      inverses.pop();
    }
  };

  try {
    while (layers.length < backup.layers.length) {
      const response = await rpc({ keymap: { addLayer: {} } });
      const added = response.keymap?.addLayer?.ok;
      if (!added?.layer) {
        throw new Error("Could not add a layer.");
      }
      const index = added.index;
      inverses.push(() => remove(index));
      layers.splice(index, 0, added.layer);
    }
    const sourceIds = backup.layers.map((l) => l.id);
    // Preserve IDs when restoring the same keyboard, including moved layers.
    // Only assign replacement IDs for layers absent from the current keymap.
    const targetLayers = selectTargetLayers(backup.layers, layers).map(
      (target, index) => {
        if (!target) {
          throw new Error("Could not assign a target layer.");
        }
        validateUnassignedBindings(
          backup.layers[index],
          target,
          behaviors,
          index,
        );
        return target;
      },
    );
    for (const [destination, target] of targetLayers.entries()) {
      const start = layers.findIndex((l) => l.id === target.id);
      if (start !== destination) {
        await move(start, destination);
        inverses.push(() => move(destination, start));
        layers.splice(destination, 0, layers.splice(start, 1)[0]);
      }
    }
    const targetIds = layers.slice(0, backup.layers.length).map((l) => l.id);
    for (const [index, source] of backup.layers.entries()) {
      const target = layers[index];
      if (source.name !== target.name) {
        await setName(target.id, source.name);
        inverses.push(() => setName(target.id, target.name));
      }
      for (const [position, binding] of source.bindings.entries()) {
        const metadata = parameterSet(
          binding,
          behaviors[binding.behaviorId],
          sourceIds,
        );
        const mapped = {
          ...binding,
          param1: remapParameter(
            binding.param1,
            metadata?.param1,
            sourceIds,
            targetIds,
          ),
          param2: remapParameter(
            binding.param2,
            metadata?.param2,
            sourceIds,
            targetIds,
          ),
        };
        const old = target.bindings[position];
        if (
          old.behaviorId === mapped.behaviorId &&
          old.param1 === mapped.param1 &&
          old.param2 === mapped.param2
        ) {
          continue;
        }
        await setBinding(target.id, position, mapped);
        inverses.push(() => setBinding(target.id, position, old));
      }
    }
    while (layers.length > backup.layers.length) {
      const index = layers.length - 1;
      const layer = layers[index];
      await remove(index);
      inverses.push(async () => {
        const response = await rpc({
          keymap: { restoreLayer: { layerId: layer.id, atIndex: index } },
        });
        if (!response.keymap?.restoreLayer?.ok) {
          throw new Error(`Could not restore layer ${index + 1}.`);
        }
      });
      layers.pop();
    }
    const response = await rpc({ keymap: { getKeymap: true } });
    if (!response.keymap?.getKeymap) {
      throw new Error("Could not reload the imported keymap.");
    }
    return { keymap: response.keymap.getKeymap, undo: rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new Error(
        `${errorMessage(error)} Rollback also failed: ${errorMessage(rollbackError)}. ` +
          "The keyboard may have partial changes. Reconnect and inspect it before saving.",
      );
    }
    throw new Error(
      `${errorMessage(error)} Acknowledged changes were rolled back. ` +
        "If the connection was interrupted, reconnect and inspect the keymap before saving.",
    );
  }
}
