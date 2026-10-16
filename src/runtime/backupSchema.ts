import { combo, macro } from "./client";

export interface RuntimeBackup {
  macroBehaviorId?: number;
  combos?: { settings: combo.GlobalSettings; definitions: combo.Combo[] };
  macros?: {
    settings: macro.MacroGlobalSettings;
    definitions: macro.MacroDetail[];
  };
  physicalKeys: {
    x: number;
    y: number;
    width: number;
    height: number;
    r: number;
    rx: number;
    ry: number;
  }[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function requireRecord(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Invalid runtime backup object.");
  return value;
}
function number(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  )
    throw new Error("Runtime values must be unsigned 32-bit integers.");
  return value;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Runtime name must be a string.");
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new Error("Invalid runtime enabled/settings flag.");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error("Expected runtime definitions array.");
  return value;
}
function binding(value: unknown): macro.BehaviorBinding {
  const data = requireRecord(value);
  return {
    behaviorId: number(data.behaviorId),
    param1: number(data.param1),
    param2: number(data.param2),
  };
}
function step(value: unknown): macro.MacroStep {
  const data = requireRecord(value);
  if (Object.keys(data).length !== 1)
    throw new Error("Macro steps require exactly one action.");
  if (data.down !== undefined) return { down: binding(data.down) };
  if (data.up !== undefined) return { up: binding(data.up) };
  if (data.tap !== undefined) return { tap: binding(data.tap) };
  if (data.delay !== undefined)
    return { delay: { delayMs: number(requireRecord(data.delay).delayMs) } };
  if (data.keyTapSequence !== undefined) {
    const packed = array(requireRecord(data.keyTapSequence).packedKeys).map(
      number,
    );
    if (packed.some((byte) => byte > 255))
      throw new Error("Invalid packed macro key.");
    return { keyTapSequence: { packedKeys: new Uint8Array(packed) } };
  }
  throw new Error("Unsupported macro step.");
}
export function parseRuntimeBackup(value: unknown): RuntimeBackup {
  const data = requireRecord(value);
  const runtime: RuntimeBackup = {
    physicalKeys: array(data.physicalKeys).map((key) => {
      const item = requireRecord(key);
      const signed = (value: unknown) => {
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new Error("Invalid physical layout geometry.");
        return value;
      };
      return {
        x: signed(item.x),
        y: signed(item.y),
        width: signed(item.width),
        height: signed(item.height),
        r: signed(item.r),
        rx: signed(item.rx),
        ry: signed(item.ry),
      };
    }),
  };
  if (data.macroBehaviorId !== undefined)
    runtime.macroBehaviorId = number(data.macroBehaviorId);
  if (data.combos !== undefined) {
    const section = requireRecord(data.combos),
      settings = requireRecord(section.settings);
    runtime.combos = {
      settings: {
        timeoutMs: number(settings.timeoutMs),
        slowRelease: bool(settings.slowRelease),
        maxCombo: number(settings.maxCombo),
        requirePriorIdleMs: number(settings.requirePriorIdleMs),
      },
      definitions: array(section.definitions).map((definition) => {
        const item = requireRecord(definition);
        const source = number(item.source),
          slowReleaseOverride = number(item.slowReleaseOverride);
        if (source > 3 || slowReleaseOverride > 2)
          throw new Error("Invalid combo source/slow-release enum.");
        return {
          index: number(item.index),
          name: string(item.name),
          keyPositions: array(item.keyPositions).map(number),
          behavior:
            item.behavior === undefined ? undefined : binding(item.behavior),
          layerMask: number(item.layerMask),
          enabled: bool(item.enabled),
          timeoutMs: number(item.timeoutMs),
          requirePriorIdleMs: number(item.requirePriorIdleMs),
          source,
          slowReleaseOverride,
        };
      }),
    };
  }
  if (data.macros !== undefined) {
    const section = requireRecord(data.macros),
      settings = requireRecord(section.settings);
    runtime.macros = {
      settings: {
        tapMs: number(settings.tapMs),
        maxEntries: number(settings.maxEntries),
        keyPressBehaviorId: number(settings.keyPressBehaviorId),
        poolBytesTotal: number(settings.poolBytesTotal),
        poolBytesUsed: number(settings.poolBytesUsed),
      },
      definitions: array(section.definitions).map((definition) => {
        const item = requireRecord(definition);
        return {
          slot: number(item.slot),
          name: string(item.name),
          steps: array(item.steps).map(step),
          encodedSize: number(item.encodedSize),
        };
      }),
    };
    if (
      new Set(runtime.macros.definitions.map((item) => item.slot)).size !==
        runtime.macros.definitions.length ||
      new Set(runtime.macros.definitions.map((item) => item.name)).size !==
        runtime.macros.definitions.length
    )
      throw new Error("Duplicate macro slot or name.");
  }
  if (
    runtime.combos &&
    new Set(runtime.combos.definitions.map((item) => item.index)).size !==
      runtime.combos.definitions.length
  )
    throw new Error("Duplicate combo slot.");
  return runtime;
}

export function runtimeBackupJSON(runtime: RuntimeBackup): unknown {
  return {
    ...runtime,
    macros: runtime.macros && {
      ...runtime.macros,
      definitions: runtime.macros.definitions.map((definition) => ({
        ...definition,
        steps: definition.steps.map((step) =>
          step.keyTapSequence
            ? {
                keyTapSequence: {
                  packedKeys: [...step.keyTapSequence.packedKeys],
                },
              }
            : step,
        ),
      })),
    },
  };
}
