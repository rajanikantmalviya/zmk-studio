import { hid_usage_get_label } from "../hid-usages";
import { layoutBounds } from "../overlay/model";

export type Binding = [number, number, number];
export type BehaviorKind =
  | "other"
  | "key"
  | "hold-tap"
  | "momentary-layer"
  | "toggle-layer"
  | "to-layer"
  | "sticky"
  | "transparent"
  | "none"
  | "tap-dance"
  | "runtime-macro"
  | "macro"
  | "mouse";
export interface ViewerBehavior {
  id: number;
  name: string;
  kind: BehaviorKind;
  children: Binding[];
}
export interface ViewerKey {
  position: number;
  x: number;
  y: number;
  width: number;
  height: number;
  r: number;
  rx: number;
  ry: number;
}
export interface ViewerLayer {
  id: number;
  name: string;
  bindings: Binding[];
}
export interface ViewerCombo {
  name: string;
  positions: number[];
  // Combo masks use ordered layer indices, unlike snapshot/keymap layer IDs.
  layers: number[];
  binding: Binding;
  timeoutMs: number;
  slot?: number;
  enabled: boolean;
  source?: string;
}
export type ViewerMacroStep =
  | { kind: "tap" | "press" | "release"; binding: Binding }
  | { kind: "delay"; delayMs: number }
  | { kind: "pause-for-release" };
export interface ViewerMacro {
  slot?: number;
  behaviorId?: number;
  name: string;
  steps: ViewerMacroStep[];
  source?: string;
  hasUnsavedChanges: boolean;
}
export interface ViewerCapabilities {
  runtimeCombos: boolean;
  runtimeMacros: boolean;
  bleStreaming: boolean;
}
export interface ViewerConfiguration {
  deviceName: string;
  layoutName: string;
  defaultLayer: number;
  keys: ViewerKey[];
  behaviors: Record<number, ViewerBehavior>;
  layers: ViewerLayer[];
  combos: ViewerCombo[];
  macros: ViewerMacro[];
  capabilities?: ViewerCapabilities;
}
export interface ViewerSnapshot {
  sequence: number;
  pressed: [number, number][];
  released: number[];
  layers: number[];
}
export interface KeyLabel {
  tap: string;
  hold?: string;
  shifted?: string;
}

const kinds: BehaviorKind[] = [
  "other",
  "key",
  "hold-tap",
  "momentary-layer",
  "toggle-layer",
  "to-layer",
  "sticky",
  "transparent",
  "none",
  "tap-dance",
  "runtime-macro",
  "macro",
  "mouse",
];

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a viewer protocol object.");
  }
  return value as Record<string, unknown>;
}
function integer(value: unknown, maximum = 0xffffffff): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    throw new Error("Invalid viewer integer.");
  }
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 256) {
    throw new Error("Invalid viewer label.");
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid viewer boolean.");
  return value;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error("Invalid viewer array.");
  }
  return value;
}
function binding(value: unknown): Binding {
  const values = array(value, 3);
  if (values.length !== 3) throw new Error("Invalid viewer binding.");
  return [integer(values[0], 65535), integer(values[1]), integer(values[2])];
}
function numbers(value: unknown, maximum: number, limit: number): number[] {
  return array(value, maximum).map((item) => integer(item, limit));
}

export function parseConfiguration(frames: unknown[]): ViewerConfiguration {
  let hello: Record<string, unknown> | undefined;
  let ready = false;
  const keys: ViewerKey[] = [];
  const layers: ViewerLayer[] = [];
  const behaviors: Record<number, ViewerBehavior> = {};
  const combos: ViewerCombo[] = [];
  const macros: ViewerMacro[] = [];
  let capabilities: ViewerCapabilities | undefined;
  for (const raw of array(frames, 512)) {
    const frame = object(raw);
    switch (frame.type) {
      case "hello":
        if (hello || frame.version !== 1)
          throw new Error("Unsupported viewer protocol version.");
        hello = frame;
        break;
      case "key": {
        const geometry = (name: string) => {
          const value = frame[name];
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            Math.abs(value) > 32768
          ) {
            throw new Error("Invalid physical key geometry.");
          }
          return value / 100;
        };
        const key = {
          position: integer(frame.position, 63),
          x: geometry("x"),
          y: geometry("y"),
          width: geometry("width"),
          height: geometry("height"),
          r: geometry("r"),
          rx: geometry("rx"),
          ry: geometry("ry"),
        };
        if (key.width <= 0 || key.height <= 0)
          throw new Error("Invalid physical key size.");
        keys.push(key);
        break;
      }
      case "behavior": {
        const id = integer(frame.id, 65534);
        if (behaviors[id] || !kinds.includes(frame.kind as BehaviorKind)) {
          throw new Error("Invalid or duplicate viewer behavior.");
        }
        behaviors[id] = {
          id,
          name: text(frame.name),
          kind: frame.kind as BehaviorKind,
          children: array(frame.children, 256).map(binding),
        };
        break;
      }
      case "layer":
        layers.push({
          id: integer(frame.id, 31),
          name: text(frame.name),
          bindings: array(frame.bindings, 64).map(binding),
        });
        break;
      case "combo":
        combos.push({
          name: text(frame.name),
          positions: numbers(frame.positions, 64, 63),
          layers: numbers(frame.layers, 32, 31),
          binding: binding(frame.binding),
          timeoutMs: integer(frame.timeoutMs),
          slot: frame.slot === undefined ? undefined : integer(frame.slot, 63),
          enabled: frame.enabled === undefined ? true : boolean(frame.enabled),
          source: frame.source === undefined ? undefined : text(frame.source),
        });
        break;
      case "macro":
        macros.push({
          slot: frame.slot === undefined ? undefined : integer(frame.slot, 63),
          behaviorId:
            frame.behaviorId === undefined
              ? undefined
              : integer(frame.behaviorId, 65535),
          name: text(frame.name),
          source: frame.source === undefined ? undefined : text(frame.source),
          hasUnsavedChanges:
            frame.hasUnsavedChanges === undefined
              ? false
              : boolean(frame.hasUnsavedChanges),
          steps: array(frame.steps, 256).map((value): ViewerMacroStep => {
            const step = object(value);
            if (step.kind === "delay")
              return { kind: "delay", delayMs: integer(step.delayMs) };
            if (step.kind === "pause-for-release")
              return { kind: "pause-for-release" };
            if (
              step.kind === "tap" ||
              step.kind === "press" ||
              step.kind === "release"
            ) {
              return { kind: step.kind, binding: binding(step.binding) };
            }
            throw new Error("Unknown firmware macro step.");
          }),
        });
        break;
      case "capabilities":
        if (capabilities) throw new Error("Duplicate viewer capabilities.");
        capabilities = {
          runtimeCombos: boolean(frame.runtimeCombos),
          runtimeMacros: boolean(frame.runtimeMacros),
          bleStreaming: boolean(frame.bleStreaming),
        };
        break;
      case "ready":
        ready = true;
        break;
      default:
        throw new Error(
          `Unknown viewer configuration frame: ${String(frame.type)}`,
        );
    }
  }
  if (
    !hello ||
    !ready ||
    !keys.length ||
    !layers.length ||
    keys.length > 64 ||
    layers.length > 32
  ) {
    throw new Error("Incomplete keyboard viewer configuration.");
  }
  keys.sort((a, b) => a.position - b.position);
  if (
    keys.some((key, index) => key.position !== index) ||
    new Set(layers.map((layer) => layer.id)).size !== layers.length ||
    layers.some((layer) => layer.bindings.length !== keys.length)
  ) {
    throw new Error("Inconsistent viewer positions or layers.");
  }
  const defaultLayer = integer(hello.defaultLayer, 31);
  if (!layers.some((layer) => layer.id === defaultLayer))
    throw new Error("Default layer is missing.");
  const checkBinding = (value: Binding) => {
    if (value[0] !== 0 && !behaviors[value[0]])
      throw new Error("Unknown firmware behavior.");
  };
  for (const layer of layers) layer.bindings.forEach(checkBinding);
  for (const behavior of Object.values(behaviors))
    behavior.children.forEach(checkBinding);
  for (const combo of combos) {
    checkBinding(combo.binding);
    if (
      !combo.positions.length ||
      new Set(combo.positions).size !== combo.positions.length ||
      combo.positions.some((position) => position >= keys.length) ||
      new Set(combo.layers).size !== combo.layers.length
    ) {
      throw new Error("Invalid combo positions or layers.");
    }
    const slots = macros.flatMap((macro) =>
      macro.slot === undefined ? [] : [macro.slot],
    );
    if (new Set(slots).size !== slots.length)
      throw new Error("Duplicate runtime macro slot.");
    for (const macro of macros) {
      if (macro.slot === undefined && macro.behaviorId === undefined) {
        throw new Error("Firmware macro is missing its identity.");
      }
      if (macro.behaviorId !== undefined && !behaviors[macro.behaviorId]) {
        throw new Error("Unknown firmware macro behavior.");
      }
      for (const step of macro.steps) {
        if ("binding" in step) checkBinding(step.binding);
      }
    }
  }
  return {
    deviceName: text(hello.deviceName),
    layoutName: text(hello.layoutName),
    defaultLayer,
    keys,
    layers,
    behaviors,
    combos,
    macros,
    capabilities,
  };
}

export function parseSnapshot(
  raw: unknown,
  config: ViewerConfiguration,
): ViewerSnapshot {
  const frame = object(raw);
  if (frame.type !== "state") throw new Error("Unexpected viewer snapshot.");
  const layerIds = new Set(config.layers.map((layer) => layer.id));
  const pressed = array(frame.pressed, 64).map((value): [number, number] => {
    const pair = array(value, 2);
    if (pair.length !== 2) throw new Error("Invalid held position.");
    const position = integer(pair[0], config.keys.length - 1);
    const origin = integer(pair[1], 31);
    if (!layerIds.has(origin)) throw new Error("Unknown held-key layer.");
    return [position, origin];
  });
  const layers = numbers(frame.layers, 32, 31);
  const released = numbers(frame.released, 64, config.keys.length - 1);
  if (
    !layers.length ||
    layers.some((id) => !layerIds.has(id)) ||
    new Set(layers).size !== layers.length ||
    new Set(pressed.map(([position]) => position)).size !== pressed.length
  ) {
    throw new Error("Invalid active layers or held positions.");
  }
  return { sequence: integer(frame.sequence), pressed, released, layers };
}

const modifierLabels = [
  "Lctrl",
  "Lshft",
  "Lalt",
  "Lgui",
  "Rctrl",
  "Rshft",
  "Ralt",
  "Rgui",
];
export function keyValue(output: number): string {
  const base = output & 0x00ffffff;
  const page = base >>> 16;
  const id = base & 0xffff;
  let label: string;
  if (page === 7 && id >= 4 && id <= 29) {
    label = String.fromCharCode(65 + id - 4);
  } else if (page === 7 && id >= 0xe0 && id <= 0xe7) {
    label = modifierLabels[id - 0xe0];
  } else if (page === 7 && id === 0x2c) {
    label = "Space";
  } else if (page === 7 && id === 0x2f) {
    label = "[";
  } else if (page === 7 && id === 0x30) {
    label = "]";
  } else {
    label =
      hid_usage_get_label(page, id)?.replace(/^Keyboard\s+/i, "") ??
      `0x${base.toString(16)}`;
  }
  const flags = output >>> 24;
  return [
    ...modifierLabels.filter((_, index) => flags & (1 << index)),
    label,
  ].join("+");
}

export function shiftedKeyValue(output: number): string | undefined {
  const base = output & 0x00ffffff;
  const id = base & 0xffff;
  // Printable US legends only; Ctrl/Alt/GUI chords are not text characters.
  if (base >>> 16 !== 7 || ((output >>> 24) & ~0x22) !== 0) return;
  if (id >= 4 && id <= 29) return String.fromCharCode(65 + id - 4);
  if (id >= 0x1e && id <= 0x27) return "!@#$%^&*()"[id - 0x1e];
  const punctuation: Record<number, string> = {
    0x2d: "_",
    0x2e: "+",
    0x2f: "{",
    0x30: "}",
    0x31: "|",
    0x33: ":",
    0x34: '"',
    0x35: "~",
    0x36: "<",
    0x37: ">",
    0x38: "?",
  };
  return punctuation[id];
}

export function bindingLabel(
  config: ViewerConfiguration,
  value: Binding,
  depth = 0,
): KeyLabel {
  if (depth > 8) return { tap: "Recursive" };
  const [id, param1, param2] = value;
  const behavior = config.behaviors[id];
  if (!behavior) return { tap: "Unassigned" };
  const layerName = (layerId: number) =>
    config.layers.find((layer) => layer.id === layerId)?.name ||
    `Layer ${layerId}`;
  const childLabel = (index: number, parameter: number) => {
    const child = behavior.children[index];
    if (!child) return { tap: "Unknown" };
    return bindingLabel(config, [child[0], parameter, child[2]], depth + 1);
  };
  switch (behavior.kind) {
    case "key": {
      const shifted = shiftedKeyValue(param1);
      return {
        tap: keyValue(param1),
        ...(shifted === undefined ? {} : { shifted }),
      };
    }
    case "hold-tap":
      return {
        ...childLabel(1, param2),
        hold: childLabel(0, param1).tap,
      };
    case "momentary-layer":
      return { tap: layerName(param1) };
    case "toggle-layer":
      return { tap: `Toggle ${layerName(param1)}` };
    case "to-layer":
      return { tap: `To ${layerName(param1)}` };
    case "sticky":
      return { tap: `Once ${childLabel(0, param1).tap}` };
    case "transparent":
      return { tap: "Transparent" };
    case "none":
      return { tap: "-" };
    case "tap-dance":
      return {
        tap:
          behavior.children
            .map((child) => bindingLabel(config, child, depth + 1).tap)
            .join(" / ") || behavior.name,
      };
    case "runtime-macro":
      return {
        tap:
          config.macros.find((macro) => macro.slot === param1)?.name ??
          `Empty macro ${param1}`,
      };
    case "macro":
      return {
        tap:
          config.macros.find((macro) => macro.behaviorId === id)?.name ??
          behavior.name,
      };
    case "mouse":
      return { tap: `Mouse ${param1}` };
    default:
      return { tap: behavior.name };
  }
}

export function effectiveBinding(
  config: ViewerConfiguration,
  position: number,
  activeLayers: number[],
): Binding {
  for (const id of activeLayers) {
    const value = config.layers.find((layer) => layer.id === id)?.bindings[
      position
    ];
    if (value && config.behaviors[value[0]]?.kind !== "transparent")
      return value;
  }
  return [0, 0, 0];
}

export function displayedKeys(
  config: ViewerConfiguration,
  state: ViewerSnapshot,
) {
  const held = new Map(state.pressed);
  return config.keys.map((key) => {
    const origin = held.get(key.position);
    const value: Binding =
      origin === undefined
        ? effectiveBinding(config, key.position, state.layers)
        : config.layers.find((layer) => layer.id === origin)?.bindings[
            key.position
          ] ?? [0, 0, 0];
    return {
      ...key,
      ...bindingLabel(config, value),
      pressed: origin !== undefined,
    };
  });
}

export function viewerBounds(config: ViewerConfiguration) {
  return layoutBounds(config.keys);
}

export interface ViewerShortcuts {
  display: boolean;
  combos: boolean;
  macros: boolean;
}

export function tapUsage(
  config: ViewerConfiguration,
  value: Binding,
  depth = 0,
): number | undefined {
  if (depth > 8) return undefined;
  const behavior = config.behaviors[value[0]];
  if (behavior?.kind === "key") return value[1];
  if (behavior?.kind === "hold-tap" && behavior.children[1]) {
    const child = behavior.children[1];
    return tapUsage(config, [child[0], value[2], child[2]], depth + 1);
  }
  return undefined;
}

export function viewerShortcuts(
  config: ViewerConfiguration,
  snapshot: ViewerSnapshot,
): ViewerShortcuts {
  // Use base-layer tap identities so layer-tap holds cannot change a chord mid-press.
  const pressed = new Set(
    snapshot.pressed.map(([position]) =>
      tapUsage(
        config,
        effectiveBinding(config, position, [config.defaultLayer]),
      ),
    ),
  );
  return {
    display: pressed.has(0x7002c) && pressed.has(0x7002a),
    combos: pressed.has(0x7002b) && pressed.has(0x70028),
    macros: pressed.has(0x70029) && pressed.has(0x7004c),
  };
}

export function viewerShortcutEdges(
  previous: ViewerShortcuts,
  next: ViewerShortcuts,
): ViewerShortcuts {
  return {
    display: next.display && !previous.display,
    combos: next.combos && !previous.combos,
    macros: next.macros && !previous.macros,
  };
}

export type ViewerPanel = "combos" | "macros" | undefined;

export function toggleViewerPanel(
  current: ViewerPanel,
  requested: Exclude<ViewerPanel, undefined>,
): ViewerPanel {
  return current === requested ? undefined : requested;
}

export function macroStepLabel(
  config: ViewerConfiguration,
  step: ViewerMacroStep,
): string {
  if (step.kind === "delay") return `Wait ${step.delayMs} ms`;
  if (step.kind === "pause-for-release") return "Wait for trigger release";
  return `${step.kind}: ${bindingLabel(config, step.binding).tap}`;
}

export function viewerOverlaySize(
  config: ViewerConfiguration,
  size: number,
  combosHeight = 0,
) {
  const bounds = viewerBounds(config);
  return {
    width: (bounds[2] * 58 * size) / 100 + 24,
    height: (bounds[3] * 58 * size) / 100 + 52 + combosHeight,
  };
}
