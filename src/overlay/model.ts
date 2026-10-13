import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type {
  Keymap,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { hid_usage_get_label } from "../hid-usages";
import { validateValue } from "../behaviors/parameters";
import { isSimpleKeyPress } from "../behaviors/virtualKeys";

export interface OverlayKey {
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
  r: number;
  rx: number;
  ry: number;
  label: string;
  behavior: string;
  outputs: number[];
  trainable: boolean;
}

export interface OverlayLayer {
  id: number;
  name: string;
  keys: OverlayKey[];
}

export type LearningMode = "find-key" | "layer-drill";

export interface LearningRequest {
  sessionId: string;
  mode: LearningMode;
  count: number;
  hints: boolean;
}

export interface OverlayConfiguration {
  revision?: number;
  sizePercent?: number;
  deviceName: string;
  layers: OverlayLayer[];
  displayedLayerId: number;
  learning: LearningRequest | null;
}

export const DEFAULT_OVERLAY_SIZE_PERCENT = 120;
export const OVERLAY_SIZE_STEP = 10;

export interface OutputKeyEvent {
  usage: number;
  pressed: boolean;
  sequence: number;
}

export interface LearningTarget {
  layerId: number;
  layerName: string;
  position: number;
  output: number;
  label: string;
}

export interface LearningSession {
  sessionId: string;
  mode: LearningMode;
  targets: LearningTarget[];
  correct: number;
  attempts: number;
  feedback: string;
}

const modifiers = [
  "L Ctrl",
  "L Shift",
  "L Alt",
  "L GUI",
  "R Ctrl",
  "R Shift",
  "R Alt",
  "R GUI",
];

export function describeOutput(output: number): string {
  const base = output & 0x00ffffff;
  const label =
    hid_usage_get_label(base >>> 16, base & 0xffff) ?? "Unknown key";
  const flags = output >>> 24;
  return [...modifiers.filter((_, i) => flags & (1 << i)), label].join(" + ");
}

export function buildOverlayLayers(
  keymap: Keymap,
  layout: PhysicalLayout,
  behaviors: Record<number, GetBehaviorDetailsResponse>,
): OverlayLayer[] {
  const layerIds = keymap.layers.map((layer) => layer.id);
  return keymap.layers.map((layer, index) => ({
    id: layer.id,
    name: layer.name || `Layer ${index}`,
    keys: layout.keys.map((physical, position) => {
      const binding = layer.bindings[position];
      const behavior = binding && behaviors[binding.behaviorId];
      const metadata = behavior?.metadata.find(
        (set) =>
          validateValue(layerIds, binding?.param1, set.param1) &&
          validateValue(layerIds, binding?.param2, set.param2),
      );
      const outputs: number[] = [];
      if (binding && metadata?.param1.some((parameter) => parameter.hidUsage)) {
        outputs.push(binding.param1 >>> 0);
      }
      if (binding && metadata?.param2.some((parameter) => parameter.hidUsage)) {
        outputs.push(binding.param2 >>> 0);
      }
      return {
        position,
        x: physical.x / 100,
        y: physical.y / 100,
        width: physical.width / 100,
        height: physical.height / 100,
        r: (physical.r ?? 0) / 100,
        rx: (physical.rx ?? physical.x) / 100,
        ry: (physical.ry ?? physical.y) / 100,
        label: outputs.length
          ? outputs.map(describeOutput).join(" / ")
          : behavior?.displayName ?? "Unassigned",
        behavior: behavior?.displayName ?? "Unassigned",
        outputs,
        trainable:
          !!behavior &&
          isSimpleKeyPress(behavior) &&
          outputs.length === 1 &&
          isMonitoredOutput(outputs[0]),
      };
    }),
  }));
}

export function isMonitoredOutput(output: number) {
  const base = output & 0x00ffffff;
  const page = base >>> 16;
  const id = base & 0xffff;
  if (page === 7) {
    return (
      (id >= 4 && id <= 0x65 && id !== 0x32) ||
      (id >= 0x67 && id <= 0x73) ||
      (id >= 0xe0 && id <= 0xe7)
    );
  }
  return (
    page === 12 &&
    [
      0xe2, 0xea, 0xe9, 0xb5, 0xb6, 0xb7, 0xcd, 0x224, 0x225, 0x227, 0x226,
      0x221, 0x22a, 0x223,
    ].includes(id)
  );
}

export function modifierMask(pressed: ReadonlySet<number>): number {
  let mask = 0;
  for (let index = 0; index < 8; index++) {
    if (pressed.has(0x700e0 + index)) mask |= 1 << index;
  }
  return mask;
}

export function isModifierUsage(usage: number) {
  return usage >= 0x700e0 && usage <= 0x700e7;
}

export function isOutputHeld(output: number, pressed: ReadonlySet<number>) {
  const base = output & 0x00ffffff;
  const required = output >>> 24;
  return pressed.has(base) && (modifierMask(pressed) & required) === required;
}

export function matchesOutput(
  output: number,
  usage: number,
  pressed: ReadonlySet<number>,
) {
  if ((output & 0x00ffffff) !== usage) return false;
  let mask = modifierMask(pressed);
  if (isModifierUsage(usage)) mask &= ~(1 << (usage - 0x700e0));
  return mask === output >>> 24;
}

export function createLearningSession(
  configuration: OverlayConfiguration,
  random: () => number = Math.random,
): LearningSession {
  const request = configuration.learning;
  if (!request) throw new Error("No learning session was requested.");
  if (
    !Number.isInteger(request.count) ||
    request.count < 1 ||
    request.count > 100
  ) {
    throw new Error(
      "Learning sessions must contain between 1 and 100 prompts.",
    );
  }
  const layer = configuration.layers.find(
    (l) => l.id === configuration.displayedLayerId,
  );
  if (!layer) throw new Error("The displayed layer is not available.");
  const candidates = layer.keys.filter((key) => key.trainable);
  if (!candidates.length) {
    throw new Error(
      "This layer has no supported Key Press bindings to practice.",
    );
  }
  const targets: LearningTarget[] = [];
  let remaining = [...candidates];
  for (let index = 0; index < request.count; index++) {
    if (!remaining.length) remaining = [...candidates];
    let choices = remaining;
    if (candidates.length > 1 && targets.length) {
      choices = remaining.filter(
        (key) => key.position !== targets[targets.length - 1].position,
      );
      if (!choices.length) choices = remaining;
    }
    const selected =
      choices[
        Math.min(choices.length - 1, Math.floor(random() * choices.length))
      ];
    remaining = remaining.filter((key) => key.position !== selected.position);
    targets.push({
      layerId: layer.id,
      layerName: layer.name,
      position: selected.position,
      output: selected.outputs[0],
      label: describeOutput(selected.outputs[0]),
    });
  }
  return {
    sessionId: request.sessionId,
    mode: request.mode,
    targets,
    correct: 0,
    attempts: 0,
    feedback: "Ready",
  };
}

export function advanceLearningSession(
  session: LearningSession,
  event: OutputKeyEvent,
  pressed: ReadonlySet<number>,
  displayedLayerId: number,
): LearningSession {
  const target = session.targets[session.correct];
  if (!target || !event.pressed) return session;
  if (displayedLayerId !== target.layerId) {
    return {
      ...session,
      feedback: `Select displayed layer "${target.layerName}" in Studio to continue.`,
    };
  }
  if (
    isModifierUsage(event.usage) &&
    !isModifierUsage(target.output & 0x00ffffff)
  ) {
    return session;
  }
  const correct = matchesOutput(target.output, event.usage, pressed);
  return {
    ...session,
    attempts: session.attempts + 1,
    correct: session.correct + (correct ? 1 : 0),
    feedback: correct ? "Correct!" : `Try ${target.label}`,
  };
}

export function layoutBounds(
  keys: Pick<OverlayKey, "x" | "y" | "width" | "height" | "r" | "rx" | "ry">[],
) {
  const points = keys.flatMap((key) => {
    const angle = (key.r * Math.PI) / 180;
    return [
      [key.x, key.y],
      [key.x + key.width, key.y],
      [key.x, key.y + key.height],
      [key.x + key.width, key.y + key.height],
    ].map(([x, y]) => [
      key.rx + (x - key.rx) * Math.cos(angle) - (y - key.ry) * Math.sin(angle),
      key.ry + (x - key.rx) * Math.sin(angle) + (y - key.ry) * Math.cos(angle),
    ]);
  });
  const minX = Math.min(0, ...points.map(([x]) => x));
  const minY = Math.min(0, ...points.map(([, y]) => y));
  const maxX = Math.max(1, ...points.map(([x]) => x));
  const maxY = Math.max(1, ...points.map(([, y]) => y));
  return [minX - 0.15, minY - 0.15, maxX - minX + 0.3, maxY - minY + 0.3];
}
