import type {
  BehaviorBinding,
  Keymap,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import {
  applyKeymapBackup,
  BehaviorMap,
  createKeymapBackup,
  errorMessage,
  KeymapBackup,
  KeymapRpc,
  selectTargetLayers,
  validateKeymapBackup,
} from "../keyboard/keymapBackup";
import { macro, RuntimeClient, RuntimeSnapshot } from "./client";
import { RuntimeBackup, runtimeBackupJSON } from "./backupSchema";
import {
  macroEncodedSize,
  macroReferences,
  runtimeMacroBehavior,
  validateCombo,
  validateMacro,
} from "./model";
import { validateValue } from "../behaviors/parameters";

const physicalKeys = (layout: PhysicalLayout) =>
  layout.keys.map(({ x, y, width, height, r, rx, ry }) => ({
    x,
    y,
    width,
    height,
    r,
    rx,
    ry,
  }));
const stepBinding = (step: macro.MacroStep) => step.tap ?? step.down ?? step.up;
function bindings(runtime: RuntimeBackup): BehaviorBinding[] {
  return [
    ...(runtime.combos?.definitions.flatMap((item) =>
      item.behavior && (item.enabled || item.keyPositions.length > 0)
        ? [item.behavior]
        : [],
    ) ?? []),
    ...(runtime.macros?.definitions.flatMap((item) =>
      item.steps.flatMap((step) => {
        const binding = stepBinding(step);
        return binding ? [binding] : [];
      }),
    ) ?? []),
  ];
}

export function createStudioBackup(
  keymap: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
  deviceName: string,
  snapshot: RuntimeSnapshot,
): KeymapBackup {
  const backup = createKeymapBackup(keymap, layout, behaviors, deviceName);
  const runtime: RuntimeBackup = {
    physicalKeys: physicalKeys(layout),
    macroBehaviorId: runtimeMacroBehavior(behaviors),
    combos: snapshot.combos && structuredClone(snapshot.combos),
    macros: snapshot.macros && {
      settings: structuredClone(snapshot.macros.settings),
      definitions: structuredClone(snapshot.macros.definitions),
    },
  };
  const ids = new Set([
    ...backup.behaviors.map((item) => item.id),
    ...bindings(runtime).map((binding) => binding.behaviorId),
    ...(runtime.macroBehaviorId !== undefined ? [runtime.macroBehaviorId] : []),
    ...(runtime.macros ? [runtime.macros.settings.keyPressBehaviorId] : []),
  ]);
  backup.behaviors = [...ids].map((id) => {
    if (!behaviors[id])
      throw new Error(
        `Behavior ${id} has not loaded; cannot export runtime definitions.`,
      );
    return { id, displayName: behaviors[id].displayName };
  });
  return { ...backup, version: 2, runtime };
}

export function studioBackupJSON(backup: KeymapBackup): unknown {
  return {
    ...backup,
    ...(backup.runtime ? { runtime: runtimeBackupJSON(backup.runtime) } : {}),
  };
}

interface RestorePlan {
  backup: KeymapBackup;
  definitions?: RuntimeBackup;
  createNames: string[];
}

export function planStudioRestore(
  backup: KeymapBackup,
  current: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
  snapshot: RuntimeSnapshot,
): RestorePlan {
  const macroBehaviorId = runtimeMacroBehavior(behaviors);
  if (backup.version === 1) {
    if (
      macroBehaviorId !== undefined &&
      backup.layers.some((layer) =>
        layer.bindings.some(
          (binding) => binding.behaviorId === macroBehaviorId,
        ),
      )
    )
      throw new Error(
        "Version 1 cannot safely restore runtime macro slot references. Export a version 2 full backup.",
      );
    validateKeymapBackup(backup, current, layout, behaviors);
    return { backup, createNames: [] };
  }
  if (!backup.runtime)
    throw new Error(
      "Version 2 requires runtime definitions and physical geometry.",
    );
  if (
    JSON.stringify(backup.runtime.physicalKeys) !==
    JSON.stringify(physicalKeys(layout))
  )
    throw new Error(
      "Backup physical key geometry differs from the active layout.",
    );
  const mapped = structuredClone(backup);
  const runtime = mapped.runtime!;
  const ids = new Map<number, number>();
  if (
    new Set(backup.behaviors.map((behavior) => behavior.displayName)).size !==
    backup.behaviors.length
  )
    throw new Error(
      "Backup behavior names are ambiguous; raw device-local IDs cannot be safely translated.",
    );
  for (const behavior of backup.behaviors) {
    const matches = Object.values(behaviors).filter(
      (target) => target.displayName === behavior.displayName,
    );
    if (matches.length !== 1)
      throw new Error(
        `Behavior "${behavior.displayName}" is missing or ambiguous on the target.`,
      );
    ids.set(behavior.id, matches[0].id);
  }
  const remapBehavior = (binding: BehaviorBinding) => {
    if (binding.behaviorId === 0 && !ids.has(0)) return;
    const id = ids.get(binding.behaviorId);
    if (id === undefined)
      throw new Error(
        `Behavior ${binding.behaviorId} has no named mapping in this backup.`,
      );
    binding.behaviorId = id;
  };
  mapped.behaviors = backup.behaviors.map((behavior) => ({
    ...behavior,
    id: ids.get(behavior.id)!,
  }));
  mapped.layers.forEach((layer) => layer.bindings.forEach(remapBehavior));
  bindings(runtime).forEach(remapBehavior);
  if (runtime.macroBehaviorId !== undefined) {
    runtime.macroBehaviorId = ids.get(runtime.macroBehaviorId);
    if (
      runtime.macroBehaviorId === undefined ||
      runtime.macroBehaviorId !== macroBehaviorId
    )
      throw new Error(
        "Runtime macro behavior identity does not match the target.",
      );
  }
  if (runtime.macros) {
    if (!snapshot.macros)
      throw new Error("Target firmware does not support runtime macros.");
    const sourceKeyPress = ids.get(runtime.macros.settings.keyPressBehaviorId);
    if (sourceKeyPress !== snapshot.macros.settings.keyPressBehaviorId)
      throw new Error(
        "Packed macro text uses a different key-press behavior on the target.",
      );
    runtime.macros.settings.keyPressBehaviorId = sourceKeyPress;
    if (runtime.macros.settings.tapMs > 10000)
      throw new Error(
        "Macro tap duration exceeds the 10000 ms firmware limit.",
      );
  }
  if (runtime.combos && !snapshot.combos)
    throw new Error("Target firmware does not support runtime combos.");
  if (
    runtime.combos &&
    (runtime.combos.settings.timeoutMs < 1 ||
      runtime.combos.settings.timeoutMs > 65535 ||
      runtime.combos.settings.requirePriorIdleMs > 65535)
  )
    throw new Error("Invalid global combo timing in backup.");
  if (snapshot.combos && !runtime.combos)
    throw new Error(
      "Backup contains no combo section for this capable target; use a complete runtime backup.",
    );
  if (snapshot.macros && !runtime.macros)
    throw new Error(
      "Backup contains no macro section for this capable target; use a complete runtime backup.",
    );
  const createNames: string[] = [];
  const slots = new Map<number, number>();
  if (runtime.macros && snapshot.macros) {
    const wantedNames = new Set(
      runtime.macros.definitions.map((item) => item.name),
    );
    const extra = snapshot.macros.definitions.filter(
      (item) => !wantedNames.has(item.name),
    );
    if (extra.length)
      throw new Error(
        `Remove target-only macros explicitly before exact restore: ${extra.map((item) => item.name).join(", ")}. Restore never silently erases persisted macros.`,
      );
    const occupied = new Set(
      snapshot.macros.definitions.map((item) => item.slot),
    );
    for (const definition of runtime.macros.definitions) {
      const sourceSlot = definition.slot;
      const existing = snapshot.macros.definitions.find(
        (item) => item.name === definition.name,
      );
      let targetSlot = existing?.slot;
      if (targetSlot === undefined) {
        targetSlot = Array.from(
          { length: snapshot.macros.settings.maxEntries },
          (_, slot) => slot,
        ).find((slot) => !occupied.has(slot));
        if (targetSlot === undefined)
          throw new Error(
            "Insufficient free macro slots before restore; no slots will be silently reused.",
          );
        if (
          macroReferences(targetSlot, macroBehaviorId, current, snapshot).length
        )
          throw new Error(
            `Free target slot ${targetSlot} has dangling references. Clear them before restore.`,
          );
        occupied.add(targetSlot);
        createNames.push(definition.name);
      }
      slots.set(sourceSlot, targetSlot);
      definition.slot = targetSlot;
    }
    const projectedBytes = runtime.macros.definitions.reduce(
      (sum, item) =>
        sum +
        macroEncodedSize(item.steps) +
        new TextEncoder().encode(item.name).length +
        7,
      0,
    );
    if (projectedBytes > snapshot.macros.settings.poolBytesTotal)
      throw new Error(
        `Restore requires ${projectedBytes} shared RAM bytes; target limit is ${snapshot.macros.settings.poolBytesTotal}.`,
      );
  }
  const allBindings = [
    ...mapped.layers.flatMap((layer) => layer.bindings),
    ...bindings(runtime),
  ];
  for (const binding of allBindings) {
    if (binding.behaviorId === macroBehaviorId) {
      const slot = slots.get(binding.param1);
      if (slot === undefined)
        throw new Error(
          `Macro slot ${binding.param1} has no named runtime definition in this backup.`,
        );
      binding.param1 = slot;
    }
  }
  // Layer-bearing runtime actions need stable target IDs before any mutation.
  // The keymap importer may allocate new IDs; reject that unsupported case.
  for (const binding of bindings(runtime)) {
    const metadata = behaviors[binding.behaviorId]?.metadata;
    const sourceLayerIds = mapped.layers.map((layer) => layer.id);
    const set = metadata?.find(
      (set) =>
        validateValue(sourceLayerIds, binding.param1, set.param1) &&
        validateValue(sourceLayerIds, binding.param2, set.param2),
    );
    if (!set && behaviors[binding.behaviorId]?.metadata.length)
      throw new Error("Invalid runtime binding parameters.");
    const remapLayer = (
      value: number,
      descriptions: typeof set extends undefined
        ? never
        : NonNullable<typeof set>["param1"],
    ) => {
      if (
        !descriptions?.some(
          (item) =>
            item.layerId && validateValue(sourceLayerIds, value, [item]),
        )
      )
        return value;
      const sourceIndex = sourceLayerIds.indexOf(value);
      const target = selectTargetLayers(mapped.layers, current.layers)[
        sourceIndex
      ];
      if (!target)
        throw new Error(
          "Runtime layer actions need an existing target layer. Add matching layers before restore.",
        );
      return target.id;
    };
    if (set) {
      binding.param1 = remapLayer(binding.param1, set.param1);
      binding.param2 = remapLayer(binding.param2, set.param2);
    }
  }
  validateKeymapBackup(mapped, current, layout, behaviors);
  if (runtime.combos) {
    for (const definition of runtime.combos.definitions) {
      if (!definition.enabled && !definition.keyPositions.length) {
        if (definition.index >= (snapshot.combos?.settings.maxCombo ?? 0))
          throw new Error("Backup combo slots exceed target capacity.");
        continue;
      }
      validateCombo(
        definition,
        snapshot,
        layout.keys.length,
        behaviors,
        current.layers.map((layer) => layer.id),
      );
    }
  }
  if (runtime.macros && snapshot.macros) {
    const emptyPool = {
      ...snapshot,
      macros: {
        ...snapshot.macros,
        settings: { ...snapshot.macros.settings, poolBytesUsed: 0 },
        definitions: [],
      },
    };
    for (const definition of runtime.macros.definitions)
      validateMacro(
        definition,
        emptyPool,
        behaviors,
        current.layers.map((layer) => layer.id),
      );
  }
  return { backup: mapped, definitions: runtime, createNames };
}

export async function applyStudioBackup(
  backup: KeymapBackup,
  current: Keymap,
  layout: PhysicalLayout,
  behaviors: BehaviorMap,
  rpc: KeymapRpc,
  client?: RuntimeClient,
) {
  const before = client ? await client.snapshot() : {};
  const plan = planStudioRestore(backup, current, layout, behaviors, before);
  if (!plan.definitions)
    return applyKeymapBackup(plan.backup, current, layout, behaviors, rpc);
  if (!client) throw new Error("Runtime transport unavailable.");
  const journal: { label: string; undo: () => Promise<void> }[] = [];
  const rollback = async () => {
    const failures: string[] = [];
    for (const entry of [...journal].reverse()) {
      try {
        await entry.undo();
      } catch (error) {
        failures.push(`${entry.label}: ${errorMessage(error)}`);
      }
    }
    if (failures.length)
      throw new Error(
        `Rollback incomplete: ${failures.join("; ")}. Reconnect, inspect all definitions, and do not Save blindly.`,
      );
  };
  const runtime = plan.definitions;
  let historyEpoch = client.persistentEpoch;
  try {
    // Free body space before growing any definitions, preserving names/slots.
    // This is deliberately non-atomic: do not type/play macros during restore.
    for (const prior of before.macros?.definitions ?? []) {
      journal.push({
        label: `macro ${prior.name}`,
        undo: () => client.putMacro(prior),
      });
      await client.macro({
        setMacroStepCount: { slot: prior.slot, stepCount: 0, persist: false },
      });
    }
    for (const name of plan.createNames) {
      // Register before sending: an interrupted response may still have applied.
      journal.push({
        label: `remove newly created ${name}`,
        undo: async () => {
          const exists = (await client.snapshot()).macros?.definitions.some(
            (item) => item.name === name,
          );
          if (exists) await client.macro({ deleteMacro: { name } });
        },
      });
      await client.macro({ createMacro: { name, persist: false } });
      const fresh = (await client.snapshot()).macros?.definitions.find(
        (item) => item.name === name,
      );
      const expected = runtime.macros?.definitions.find(
        (item) => item.name === name,
      );
      if (!fresh || fresh.slot !== expected?.slot)
        throw new Error(
          "Firmware allocated a different macro slot; restore stopped before assigning references.",
        );
    }
    for (const definition of runtime.macros?.definitions ?? []) {
      await client.putMacro(definition);
    }
    if (runtime.macros && before.macros) {
      journal.push({
        label: "macro tap timing",
        undo: async () => {
          await client.macro({
            setTapMs: { tapMs: before.macros!.settings.tapMs, persist: false },
          });
        },
      });
      await client.macro({
        setTapMs: { tapMs: runtime.macros.settings.tapMs, persist: false },
      });
    }
    if (runtime.combos && before.combos) {
      for (const target of before.combos.definitions) {
        const definition = runtime.combos.definitions.find(
          (item) => item.index === target.index,
        );
        journal.push({
          label: `combo ${target.index}`,
          undo: () => client.putCombo(target),
        });
        await client.putCombo(
          definition ?? {
            ...target,
            name: "",
            enabled: false,
            keyPositions: [],
            behavior: undefined,
          },
        );
      }
      const settings = runtime.combos.settings,
        prior = before.combos.settings;
      journal.push({
        label: "combo global timing",
        undo: async () => {
          await client.combo({
            setTimeoutMs: { timeoutMs: prior.timeoutMs, persist: false },
          });
          await client.combo({
            setSlowRelease: { slowRelease: prior.slowRelease, persist: false },
          });
          await client.combo({
            setRequirePriorIdleMs: {
              requirePriorIdleMs: prior.requirePriorIdleMs,
              persist: false,
            },
          });
        },
      });
      await client.combo({
        setTimeoutMs: { timeoutMs: settings.timeoutMs, persist: false },
      });
      await client.combo({
        setSlowRelease: { slowRelease: settings.slowRelease, persist: false },
      });
      await client.combo({
        setRequirePriorIdleMs: {
          requirePriorIdleMs: settings.requirePriorIdleMs,
          persist: false,
        },
      });
    }
    const result = await applyKeymapBackup(
      plan.backup,
      current,
      layout,
      behaviors,
      rpc,
    );
    journal.push({ label: "keymap", undo: result.undo });
    return {
      keymap: result.keymap,
      undo: async () => {
        if (client.persistentEpoch !== historyEpoch)
          throw new Error(
            "Restore undo crossed a Save/Discard or persistent lifecycle operation. Export current state and use an explicit restore instead; deleting an imported macro could leave saved slot references dangling.",
          );
        try {
          await rollback();
        } finally {
          historyEpoch = client.persistentEpoch;
        }
      },
    };
  } catch (error) {
    try {
      await rollback();
    } catch (failure) {
      throw new Error(`${errorMessage(error)} ${errorMessage(failure)}`);
    }
    throw new Error(
      `${errorMessage(error)} Acknowledged/possibly applied runtime writes were rolled back in memory; keymap importer reports its own rollback state. No persistent save was requested.`,
    );
  }
}
