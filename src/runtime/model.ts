import type {
  BehaviorBinding,
  Keymap,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import type { BehaviorMap } from "../keyboard/keymapBackup";
import { combo, macro, RuntimeSnapshot } from "./client";
import { validateValue } from "../behaviors/parameters";

export function validateRuntimeBinding(
  binding: BehaviorBinding,
  behaviors: BehaviorMap,
  layerIds: number[],
) {
  if (
    [binding.behaviorId, binding.param1, binding.param2].some(
      (value) => !Number.isInteger(value) || value < 0 || value > 0xffffffff,
    )
  )
    throw new Error(
      "Runtime behavior parameters must be unsigned 32-bit integers.",
    );
  const behavior = behaviors[binding.behaviorId];
  if (!behavior)
    throw new Error("Runtime action uses an unavailable behavior.");
  if (behavior.metadata.length === 0) {
    if (binding.param1 !== 0 || binding.param2 !== 0)
      throw new Error("Runtime action has invalid behavior parameters.");
  } else if (
    !behavior.metadata.some(
      (set) =>
        validateValue(layerIds, binding.param1, set.param1) &&
        validateValue(layerIds, binding.param2, set.param2),
    )
  )
    throw new Error("Runtime action has invalid behavior parameters.");
}

export function runtimeMacroBehavior(
  behaviors: BehaviorMap,
): number | undefined {
  const matches = Object.values(behaviors).filter((b) =>
    /^runtime macro$/i.test(b.displayName),
  );
  return matches.length === 1 ? matches[0].id : undefined;
}

export function macroReferences(
  slot: number,
  behaviorId: number | undefined,
  keymap: Keymap,
  snapshot: RuntimeSnapshot,
): string[] {
  if (behaviorId === undefined) return [];
  const matches = (binding: BehaviorBinding | undefined) =>
    binding?.behaviorId === behaviorId && binding.param1 === slot;
  const references: string[] = [];
  for (const layer of keymap.layers)
    layer.bindings.forEach((binding, position) => {
      if (matches(binding))
        references.push(`layer "${layer.name}", key ${position + 1}`);
    });
  for (const definition of snapshot.combos?.definitions ?? [])
    if (definition.keyPositions.length > 0 && matches(definition.behavior))
      references.push(`combo "${definition.name || definition.index}"`);
  for (const definition of snapshot.macros?.definitions ?? [])
    if (
      definition.steps.some((step) => matches(step.tap ?? step.down ?? step.up))
    )
      references.push(`macro "${definition.name}"`);
  return references;
}

export function validateCombo(
  definition: combo.Combo,
  snapshot: RuntimeSnapshot,
  keyCount: number,
  behaviors: BehaviorMap,
  layerIds: number[] = [],
) {
  if (
    !snapshot.combos ||
    definition.index < 0 ||
    definition.index >= snapshot.combos.settings.maxCombo
  )
    throw new Error("Combo slot is outside firmware capacity.");
  if (new TextEncoder().encode(definition.name).length > 63)
    throw new Error(
      "Combo names are limited to 63 UTF-8 bytes (64-byte wire buffer includes NUL).",
    );
  if (
    new TextDecoder().decode(new TextEncoder().encode(definition.name)) !==
    definition.name
  )
    throw new Error("Combo names must be well-formed Unicode.");
  if ([...definition.name].some((character) => character.charCodeAt(0) < 32))
    throw new Error("Combo names cannot contain control characters.");
  if (definition.keyPositions.length < 2 || definition.keyPositions.length > 4)
    throw new Error(
      "Combo definitions require 2 to 4 physical keys on this firmware profile.",
    );
  if (
    new Set(definition.keyPositions).size !== definition.keyPositions.length ||
    definition.keyPositions.some(
      (key) => !Number.isInteger(key) || key < 0 || key >= keyCount,
    )
  )
    throw new Error(
      "Combo contains invalid or duplicate physical key positions.",
    );
  if (!definition.behavior || !behaviors[definition.behavior.behaviorId])
    throw new Error("Choose an available combo behavior.");
  validateRuntimeBinding(definition.behavior, behaviors, layerIds);
  if (definition.slowReleaseOverride < 0 || definition.slowReleaseOverride > 2)
    throw new Error("Invalid slow-release override.");
  for (const value of [
    definition.timeoutMs,
    definition.requirePriorIdleMs,
    definition.layerMask,
  ])
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error(
        "Combo timing and layer mask must be unsigned 32-bit values.",
      );
  if (definition.timeoutMs > 65535 || definition.requirePriorIdleMs > 65535)
    throw new Error("Combo timing is limited to 65535 ms.");
}

export function comboOverlaps(
  definition: combo.Combo,
  others: combo.Combo[],
): string[] {
  return others
    .filter(
      (other) =>
        other.index !== definition.index &&
        other.enabled &&
        definition.enabled &&
        (!other.layerMask ||
          !definition.layerMask ||
          (other.layerMask & definition.layerMask) !== 0) &&
        other.keyPositions.some((key) => definition.keyPositions.includes(key)),
    )
    .map((other) => other.name || `slot ${other.index}`);
}

export function validateMacro(
  definition: macro.MacroDetail,
  snapshot: RuntimeSnapshot,
  behaviors: BehaviorMap,
  layerIds: number[] = [],
) {
  const capacity = snapshot.macros;
  if (!capacity) throw new Error("Runtime macros are unsupported.");
  const nameBytes = new TextEncoder().encode(definition.name).length;
  if (!nameBytes || nameBytes > capacity.maxNameLength)
    throw new Error(
      `Macro names require 1 to ${capacity.maxNameLength} UTF-8 bytes.`,
    );
  if (
    new TextDecoder().decode(new TextEncoder().encode(definition.name)) !==
    definition.name
  )
    throw new Error("Macro names must be well-formed Unicode.");
  if (
    [...definition.name].some(
      (character) => character.charCodeAt(0) < 32 || character === "/",
    )
  )
    throw new Error("Macro names cannot contain control characters or '/'.");
  const actions = definition.steps.reduce(
    (count, step) => count + (step.keyTapSequence?.packedKeys.length ?? 1),
    0,
  );
  if (actions > 64)
    throw new Error(
      "Macro exceeds the 64-action playback queue in this firmware profile.",
    );
  for (const step of definition.steps) {
    const alternatives = [
      step.tap,
      step.down,
      step.up,
      step.delay,
      step.keyTapSequence,
    ].filter((value) => value !== undefined);
    if (alternatives.length !== 1)
      throw new Error("Each macro step requires exactly one action.");
    const binding = step.tap ?? step.down ?? step.up;
    if (binding) validateRuntimeBinding(binding, behaviors, layerIds);
    if (
      step.delay &&
      (!Number.isInteger(step.delay.delayMs) ||
        step.delay.delayMs < 0 ||
        step.delay.delayMs > 0xffffffff)
    )
      throw new Error("Macro delays must be unsigned 32-bit values.");
    if (
      step.keyTapSequence?.packedKeys.some(
        (key) => (key & 0x7f) < 4 || (key & 0x7f) > 56,
      )
    )
      throw new Error("Packed macro text contains unsupported US key usages.");
  }
  const bytes = macroEncodedSize(definition.steps);
  if (bytes > capacity.maxBytes)
    throw new Error(
      `Macro body needs ${bytes} bytes; limit is ${capacity.maxBytes}.`,
    );
  const prior = capacity.definitions.find(
    (item) => item.name === definition.name,
  );
  const priorSize = prior
    ? macroEncodedSize(prior.steps) +
      new TextEncoder().encode(prior.name).length +
      7
    : 0;
  if (
    capacity.settings.poolBytesUsed - priorSize + bytes + nameBytes + 7 >
    capacity.settings.poolBytesTotal
  )
    throw new Error("Macro exceeds the shared RAM pool.");
}

// Firmware compact encoding starts with a version byte; opcode operands are
// unsigned varints. Key sequences contain one packed US key per byte.
export function macroEncodedSize(steps: macro.MacroStep[]): number {
  const varint = (value: number) => {
    let bytes = 1;
    while (value >= 128) {
      value = Math.floor(value / 128);
      bytes++;
    }
    return bytes;
  };
  return (
    1 +
    steps.reduce((total, step) => {
      const binding = step.tap ?? step.down ?? step.up;
      return (
        total +
        1 +
        (step.delay
          ? varint(step.delay.delayMs)
          : step.keyTapSequence
            ? varint(step.keyTapSequence.packedKeys.length) +
              step.keyTapSequence.packedKeys.length
            : binding
              ? varint(binding.behaviorId) +
                varint(binding.param1) +
                varint(binding.param2)
              : 0)
      );
    }, 0)
  );
}

export function textSteps(
  text: string,
  keyPressBehaviorId: number,
): macro.MacroStep[] {
  const punctuation: Record<string, [number, boolean]> = {
    " ": [44, false],
    "\n": [40, false],
    "\t": [43, false],
    "-": [45, false],
    _: [45, true],
    "=": [46, false],
    "+": [46, true],
    "[": [47, false],
    "{": [47, true],
    "]": [48, false],
    "}": [48, true],
    "\\": [49, false],
    "|": [49, true],
    ";": [51, false],
    ":": [51, true],
    "'": [52, false],
    '"': [52, true],
    "`": [53, false],
    "~": [53, true],
    ",": [54, false],
    "<": [54, true],
    ".": [55, false],
    ">": [55, true],
    "/": [56, false],
    "?": [56, true],
  };
  return [...text].map((character) => {
    let key: number,
      shift = false;
    if (/^[a-z]$/i.test(character)) {
      key = character.toLowerCase().charCodeAt(0) - 97 + 4;
      shift = character === character.toUpperCase();
    } else if (/^[0-9]$/.test(character))
      key = character === "0" ? 39 : 29 + Number(character);
    else if ("!@#$%^&*()".includes(character)) {
      key = 30 + "!@#$%^&*()".indexOf(character);
      shift = true;
    } else if (punctuation[character]) [key, shift] = punctuation[character];
    else
      throw new Error(
        `Text shortcut supports US keyboard ASCII only; unsupported character ${JSON.stringify(character)}.`,
      );
    return {
      tap: {
        behaviorId: keyPressBehaviorId,
        param1: (7 << 16) | key | (shift ? 2 << 24 : 0),
        param2: 0,
      },
    };
  });
}
