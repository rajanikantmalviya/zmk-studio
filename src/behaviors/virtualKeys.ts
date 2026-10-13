import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import { hid_usage_from_page_and_id } from "../hid-usages";

export interface HidUsagePage {
  id: number;
  min?: number;
  max?: number;
}

interface VirtualKey {
  label: string;
  usage: number;
  width: number;
}

const key = (label: string, id: number, width = 1, page = 7): VirtualKey => ({
  label,
  usage: hid_usage_from_page_and_id(page, id),
  width,
});

export const virtualKeyboards: Record<string, VirtualKey[][]> = {
  Keyboard: [
    [
      key("Esc", 0x29),
      ...Array.from({ length: 12 }, (_, i) => key(`F${i + 1}`, 0x3a + i)),
    ],
    [
      key("`", 0x35),
      ...Array.from({ length: 9 }, (_, i) => key(`${i + 1}`, 0x1e + i)),
      key("0", 0x27),
      key("-", 0x2d),
      key("=", 0x2e),
      key("Backspace", 0x2a, 2),
    ],
    [
      key("Tab", 0x2b, 1.5),
      key("Q", 0x14),
      key("W", 0x1a),
      key("E", 8),
      key("R", 0x15),
      key("T", 0x17),
      key("Y", 0x1c),
      key("U", 0x18),
      key("I", 0xc),
      key("O", 0x12),
      key("P", 0x13),
      key("[", 0x2f),
      key("]", 0x30),
      key("\\", 0x31, 1.5),
    ],
    [
      key("Caps", 0x39, 1.75),
      key("A", 4),
      key("S", 0x16),
      key("D", 7),
      key("F", 9),
      key("G", 0xa),
      key("H", 0xb),
      key("J", 0xd),
      key("K", 0xe),
      key("L", 0xf),
      key(";", 0x33),
      key("'", 0x34),
      key("Enter", 0x28, 2.25),
    ],
    [
      key("L Shift", 0xe1, 2.25),
      key("Z", 0x1d),
      key("X", 0x1b),
      key("C", 6),
      key("V", 0x19),
      key("B", 5),
      key("N", 0x11),
      key("M", 0x10),
      key(",", 0x36),
      key(".", 0x37),
      key("/", 0x38),
      key("R Shift", 0xe5, 2.75),
    ],
    [
      key("L Ctrl", 0xe0, 1.25),
      key("L GUI", 0xe3, 1.25),
      key("L Alt", 0xe2, 1.25),
      key("Space", 0x2c, 6.25),
      key("R Alt", 0xe6, 1.25),
      key("R GUI", 0xe7, 1.25),
      key("Menu", 0x65, 1.25),
      key("R Ctrl", 0xe4, 1.25),
    ],
    [
      key("Print", 0x46),
      key("Scroll", 0x47),
      key("Pause", 0x48),
      key("Insert", 0x49),
      key("Home", 0x4a),
      key("PgUp", 0x4b),
      key("Delete", 0x4c),
      key("End", 0x4d),
      key("PgDn", 0x4e),
      key("Left", 0x50),
      key("Down", 0x51),
      key("Up", 0x52),
      key("Right", 0x4f),
    ],
  ],
  Numpad: [
    [
      key("Num Lock", 0x53),
      key("Num /", 0x54),
      key("Num *", 0x55),
      key("Num -", 0x56),
    ],
    [
      key("Num 7", 0x5f),
      key("Num 8", 0x60),
      key("Num 9", 0x61),
      key("Num +", 0x57),
    ],
    [key("Num 4", 0x5c), key("Num 5", 0x5d), key("Num 6", 0x5e)],
    [key("Num 1", 0x59), key("Num 2", 0x5a), key("Num 3", 0x5b)],
    [key("Num 0", 0x62, 2), key("Num .", 0x63), key("Num Enter", 0x58)],
  ],
  Media: [
    [
      key("Mute", 0xe2, 1, 12),
      key("Volume -", 0xea, 1, 12),
      key("Volume +", 0xe9, 1, 12),
      key("Play / Pause", 0xcd, 1, 12),
      key("Previous", 0xb6, 1, 12),
      key("Next", 0xb5, 1, 12),
      key("Stop", 0xb7, 1, 12),
    ],
    [
      key("Brightness -", 0x70, 1, 12),
      key("Brightness +", 0x6f, 1, 12),
      key("Browser Back", 0x224, 1, 12),
      key("Browser Forward", 0x225, 1, 12),
      key("Browser Home", 0x223, 1, 12),
      key("Calculator", 0x192, 1, 12),
    ],
  ],
};

export function isUsageAllowed(usage: number, pages: HidUsagePage[]) {
  const page = (usage >>> 16) & 0xff;
  const id = usage & 0xffff;
  return pages.some(
    (p) =>
      p.id === page &&
      ((id >= (p.min ?? 0) && id <= (p.max || Number.MAX_SAFE_INTEGER)) ||
        (page === 7 && id >= 0xe0 && id <= 0xe7)),
  );
}

export function withImplicitModifiers(usage: number, modifiers: number) {
  return ((usage & 0x00ffffff) | ((modifiers & 0xff) << 24)) >>> 0;
}

export function isSimpleKeyPress(behavior: GetBehaviorDetailsResponse) {
  const set = behavior.metadata[0];
  return (
    behavior.metadata.length === 1 &&
    set.param1.length === 1 &&
    !!set.param1[0].hidUsage &&
    set.param2.every((parameter) => !!parameter.nil)
  );
}
