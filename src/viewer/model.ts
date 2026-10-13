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
  layers: number[];
  binding: Binding;
  timeoutMs: number;
}
export interface ViewerConfiguration {
  deviceName: string;
  layoutName: string;
  defaultLayer: number;
  keys: ViewerKey[];
  behaviors: Record<number, ViewerBehavior>;
  layers: ViewerLayer[];
  combos: ViewerCombo[];
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
        });
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
      combo.layers.some((id) => !layers.some((layer) => layer.id === id))
    ) {
      throw new Error("Invalid combo positions or layers.");
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
    case "key":
      return { tap: keyValue(param1) };
    case "hold-tap":
      return {
        tap: childLabel(1, param2).tap,
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
}

function tapUsage(
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
  };
}

export function viewerShortcutEdges(
  previous: ViewerShortcuts,
  next: ViewerShortcuts,
): ViewerShortcuts {
  return {
    display: next.display && !previous.display,
    combos: next.combos && !previous.combos,
  };
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
