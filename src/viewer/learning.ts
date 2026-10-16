import {
  Binding,
  effectiveBinding,
  shiftedKeyValue,
  tapUsage,
  ViewerConfiguration,
} from "./model";

export interface LearningKey {
  character: string;
  position: number;
  shifted: boolean;
}
export type PracticeKind = "keys" | "words";

function characterForUsage(usage: number): string | undefined {
  if ((usage & 0x00ff0000) !== 0x70000 || (usage >>> 24) & ~0x22) return;
  const id = usage & 0xffff;
  if (id === 0x2c) return " ";
  if (usage >>> 24) return shiftedKeyValue(usage);
  if (id >= 4 && id <= 29) return String.fromCharCode(97 + id - 4);
  if (id >= 0x1e && id <= 0x27) return "1234567890"[id - 0x1e];
  const punctuation: Record<number, string> = {
    0x2d: "-",
    0x2e: "=",
    0x2f: "[",
    0x30: "]",
    0x31: "\\",
    0x33: ";",
    0x34: "'",
    0x35: "`",
    0x36: ",",
    0x37: ".",
    0x38: "/",
  };
  return punctuation[id];
}

function hasShift(config: ViewerConfiguration, value: Binding): boolean {
  const usage = tapUsage(config, value);
  if (usage === 0x700e1 || usage === 0x700e5) return true;
  const behavior = config.behaviors[value[0]];
  if (behavior?.kind !== "hold-tap" || !behavior.children[0]) return false;
  const child = behavior.children[0];
  const hold = tapUsage(config, [child[0], value[1], child[2]]);
  return hold === 0x700e1 || hold === 0x700e5;
}

export function learningKeys(
  config: ViewerConfiguration,
  layerId: number,
  includeShift: boolean,
): LearningKey[] {
  const layers = [...new Set([layerId, config.defaultLayer])];
  const bindings = config.keys.map((key) => ({
    position: key.position,
    binding: effectiveBinding(config, key.position, layers),
  }));
  const shiftPositions = bindings.filter(({ binding }) =>
    hasShift(config, binding),
  );
  const keys = new Map<string, LearningKey>();
  for (const { position, binding } of bindings) {
    const usage = tapUsage(config, binding);
    if (usage === undefined) continue;
    const character = characterForUsage(usage);
    if (character === undefined) continue;
    if (!keys.has(character))
      keys.set(character, { character, position, shifted: false });
    const shifted =
      includeShift &&
      shiftPositions.some((key) => key.position !== position) &&
      shiftedKeyValue(usage);
    if (shifted && !keys.has(shifted))
      keys.set(shifted, { character: shifted, position, shifted: true });
  }
  return [...keys.values()];
}

const words = (
  "a i an as at be by do go he if in is it me my no of on or so to up us we " +
  "all and are back be been but can come day did down each even find first for " +
  "from get give good had has have help her here him his home how into just " +
  "keep know last learn left like line little long look made make many more " +
  "most much must name need new next not now off one only open other our out " +
  "over own part people place play point put read right run said same see " +
  "she should show small some sound start still such take tell than that " +
  "the their them then there these they thing think this those time too " +
  "try turn two type under use very want was way well went were what when " +
  "where which while who will with word work world would write year you your"
).split(" ");

export function practiceText(
  keys: LearningKey[],
  kind: PracticeKind,
  random: () => number = Math.random,
): string {
  const characters = keys.map((key) => key.character);
  const nonSpace = characters.filter((character) => character !== " ");
  if (!nonSpace.length) return "";
  const pick = <T>(items: T[]) =>
    items[Math.min(items.length - 1, Math.floor(random() * items.length))];
  if (kind === "words" && characters.includes(" ")) {
    const available = words.filter((word) =>
      [...word].every((character) => characters.includes(character)),
    );
    if (available.length)
      return Array.from({ length: 12 }, () => pick(available)).join(" ") + " ";
  }
  // Key drills cover every mapped character, even on small/symbol layers.
  const shuffled = [...nonSpace];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other], shuffled[index]];
  }
  const groups = shuffled.map((character, index) =>
    kind === "keys"
      ? character.repeat(3) +
        character +
        shuffled[(index + 1) % shuffled.length]
      : Array.from({ length: 4 }, () => pick(nonSpace)).join(""),
  );
  return characters.includes(" ") ? groups.join(" ") + " " : groups.join("");
}

export interface LearningSession {
  status: "running" | "paused" | "finished";
  durationMs: number;
  activeMs: number;
  resumedAt: number;
  attempts: { at: number; correct: boolean }[];
}

export function startSession(durationMs: number, now: number): LearningSession {
  return {
    status: "running",
    durationMs,
    activeMs: 0,
    resumedAt: now,
    attempts: [],
  };
}

export function elapsedMs(session: LearningSession, now: number): number {
  return Math.min(
    session.durationMs,
    session.activeMs +
      (session.status === "running" ? Math.max(0, now - session.resumedAt) : 0),
  );
}

export function stopSession(
  session: LearningSession,
  now: number,
  finish = false,
): LearningSession {
  const activeMs = elapsedMs(session, now);
  return {
    ...session,
    activeMs,
    status: finish || activeMs >= session.durationMs ? "finished" : "paused",
  };
}

export function resumeSession(
  session: LearningSession,
  now: number,
): LearningSession {
  return session.status === "paused"
    ? { ...session, status: "running", resumedAt: now }
    : session;
}

export function recordAttempt(
  session: LearningSession,
  correct: boolean,
  now: number,
): LearningSession {
  if (session.status !== "running") return session;
  const at = elapsedMs(session, now);
  if (at >= session.durationMs) return stopSession(session, now, true);
  return { ...session, attempts: [...session.attempts, { at, correct }] };
}

export function sessionMetrics(session: LearningSession, now: number) {
  const elapsed = elapsedMs(session, now);
  const correct = session.attempts.filter((attempt) => attempt.correct);
  const wpm = (windowMs: number) => {
    const duration = Math.min(windowMs, elapsed);
    if (duration <= 0) return 0;
    const count = correct.filter(
      (attempt) => attempt.at > elapsed - windowMs && attempt.at <= elapsed,
    ).length;
    return (count * 60000) / (5 * duration);
  };
  return {
    elapsed,
    correct: correct.length,
    mistakes: session.attempts.length - correct.length,
    accuracy: session.attempts.length
      ? (correct.length / session.attempts.length) * 100
      : 100,
    average: wpm(Infinity),
    minute: wpm(60000),
    twoMinutes: wpm(120000),
  };
}
