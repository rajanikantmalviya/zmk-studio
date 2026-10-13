import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { emitTo, listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  getOverlayConfiguration,
  getOverlayPressedKeys,
} from "../tauri/overlay";
import {
  advanceLearningSession,
  createLearningSession,
  isOutputHeld,
  layoutBounds,
  LearningSession,
  modifierMask,
  OutputKeyEvent,
  OverlayConfiguration,
} from "./model";

interface ReleasedKey {
  expires: number;
  modifiers: number;
}

export function OverlayApp() {
  const [displayScale, setDisplayScale] = useState(
    () => window.innerWidth / 1000,
  );
  const [config, setConfig] = useState<OverlayConfiguration | null>(null);
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const [released, setReleased] = useState<Map<number, ReleasedKey>>(new Map());
  const [session, setSession] = useState<LearningSession | null>(null);
  const [error, setError] = useState<string>();
  const configRef = useRef<OverlayConfiguration | null>(null);
  const pressedRef = useRef(new Set<number>());
  const sessionRef = useRef<LearningSession | null>(null);
  const sequenceRef = useRef(-1);
  const configRevision = useRef(-1);

  useEffect(() => {
    let disposed = false;
    const resize = () => setDisplayScale(window.innerWidth / 1000);
    window.addEventListener("resize", resize);
    const unlisteners: UnlistenFn[] = [];
    const pressedKeys = pressedRef.current;
    const publishSession = (next: LearningSession | null) => {
      sessionRef.current = next;
      setSession(next);
      if (next) {
        emitTo("main", "keyboard-overlay-learning", {
          sessionId: next.sessionId,
          correct: next.correct,
          attempts: next.attempts,
          total: next.targets.length,
          feedback: next.feedback,
        }).catch((cause) => {
          console.error("Could not report learning progress", cause);
          if (!disposed) setError(String(cause));
        });
      }
    };
    const applyConfig = (next: OverlayConfiguration | null) => {
      if (disposed) return;
      if (next && (next.revision ?? 0) < configRevision.current) return;
      if (next) configRevision.current = next.revision ?? 0;
      configRef.current = next;
      setConfig(next);
      if (!next?.learning) {
        publishSession(null);
      } else if (sessionRef.current?.sessionId !== next.learning.sessionId) {
        try {
          publishSession(createLearningSession(next));
          setError(undefined);
        } catch (cause) {
          console.error("Could not start learning session", cause);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    const onKey = (event: OutputKeyEvent) => {
      if (disposed) return;
      if (event.sequence <= sequenceRef.current) return;
      sequenceRef.current = event.sequence;
      const current = pressedKeys;
      const wasPressed = current.has(event.usage);
      if (event.pressed && wasPressed) return;
      const releaseModifiers = modifierMask(current);
      if (event.pressed) {
        current.add(event.usage);
        setReleased((previous) => {
          const next = new Map(previous);
          next.delete(event.usage);
          return next;
        });
      } else {
        current.delete(event.usage);
        if (wasPressed) {
          setReleased((previous) =>
            new Map(previous).set(event.usage, {
              expires: Date.now() + 250,
              modifiers: releaseModifiers,
            }),
          );
        }
      }
      setPressed(new Set(current));
      const previousSession = sessionRef.current;
      const configuration = configRef.current;
      if (previousSession && configuration) {
        const next = advanceLearningSession(
          previousSession,
          event,
          current,
          configuration.displayedLayerId,
        );
        if (next !== previousSession) publishSession(next);
      }
    };
    const start = async () => {
      const subscriptions: (() => Promise<UnlistenFn>)[] = [
        () =>
          listen<OverlayConfiguration>("keyboard-overlay-config", (event) =>
            applyConfig(event.payload),
          ),
        () =>
          listen<OutputKeyEvent>("keyboard-overlay-key", (event) =>
            onKey(event.payload),
          ),
      ];
      for (const subscribe of subscriptions) {
        const unlisten = await subscribe();
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      }
      applyConfig(await getOverlayConfiguration());
      const snapshot = await getOverlayPressedKeys();
      if (!disposed && snapshot.sequence >= sequenceRef.current) {
        sequenceRef.current = snapshot.sequence;
        pressedKeys.clear();
        for (const usage of snapshot.pressed) pressedKeys.add(usage);
        setPressed(new Set(pressedKeys));
      }
    };
    start().catch((cause) => {
      console.error("Could not initialize keyboard overlay", cause);
      if (!disposed) setError(String(cause));
    });
    const timer = setInterval(() => {
      if (disposed) return;
      setReleased((previous) => {
        const now = Date.now();
        if (![...previous.values()].some((key) => key.expires <= now))
          return previous;
        return new Map([...previous].filter(([, key]) => key.expires > now));
      });
    }, 100);
    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      clearInterval(timer);
      for (const unlisten of unlisteners) unlisten();
      pressedKeys.clear();
      sequenceRef.current = -1;
      configRevision.current = -1;
    };
  }, []);

  const layer = config?.layers.find(
    (candidate) => candidate.id === config.displayedLayerId,
  );
  const target = session?.targets[session.correct];
  const complete = !!session && session.correct === session.targets.length;
  const accuracy = session?.attempts
    ? Math.round((session.correct / session.attempts) * 100)
    : 0;

  const panelStyle: CSSProperties & { "--overlay-scale": number } = {
    "--overlay-scale": displayScale,
  };

  return (
    <div className="overlay-panel" style={panelStyle}>
      <header className="overlay-header">
        <strong>{config?.deviceName ?? "ZMK Studio"}</strong>
        <span>
          Layer: {layer?.name ?? "Not selected"} <b>(manual)</b>
        </span>
        <span className="overlay-legend">
          <i className="legend-down" /> Key down <i className="legend-up" /> Key
          released
        </span>
      </header>
      {error && (
        <p role="alert" className="overlay-error">
          {error}
        </p>
      )}
      {session && (
        <div className="overlay-learning" role="status">
          {complete ? (
            <strong>
              Session complete! {session.targets.length} prompts · {accuracy}%
              accuracy
            </strong>
          ) : (
            <>
              <strong>
                {session.mode === "layer-drill"
                  ? `On "${target?.layerName}", press `
                  : "Find and press "}
                {target?.label}
              </strong>
              <span>
                {session.correct + 1}/{session.targets.length} ·{" "}
                {session.feedback} · {accuracy}% accuracy
              </span>
            </>
          )}
        </div>
      )}
      {layer && (
        <svg
          className="overlay-keyboard"
          viewBox={layoutBounds(layer.keys).join(" ")}
          aria-label={`Keyboard layout, manually selected layer ${layer.name}`}
        >
          {layer.keys.map((key) => {
            const down = key.outputs.some((output) =>
              isOutputHeld(output, pressed),
            );
            const up =
              !down &&
              key.outputs.some((output) => {
                const release = released.get(output & 0x00ffffff);
                return (
                  !!release &&
                  (release.modifiers & (output >>> 24)) === output >>> 24
                );
              });
            const hint =
              !!config?.learning?.hints &&
              target?.layerId === layer.id &&
              target.position === key.position;
            const maximumLength = Math.max(4, Math.floor(key.width * 9));
            const label =
              key.label.length > maximumLength
                ? `${key.label.slice(0, maximumLength - 1)}…`
                : key.label;
            return (
              <g
                key={key.position}
                transform={`rotate(${key.r} ${key.rx} ${key.ry})`}
              >
                <title>
                  {key.label} ({key.behavior})
                </title>
                <rect
                  x={key.x + 0.035}
                  y={key.y + 0.035}
                  width={Math.max(0.01, key.width - 0.07)}
                  height={Math.max(0.01, key.height - 0.07)}
                  rx="0.09"
                  fill={down ? "#10b981" : up ? "#6366f1" : "#273449"}
                  stroke={hint ? "#fbbf24" : "#64748b"}
                  strokeWidth={hint ? 0.05 : 0.015}
                  data-position={key.position}
                  data-state={down ? "down" : up ? "released" : "idle"}
                />
                <text
                  x={key.x + key.width / 2}
                  y={key.y + key.height / 2}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize="0.17"
                  fill={down ? "#052e25" : "#f1f5f9"}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <footer className="overlay-note">
        Windows output only · All physical keyboards · Layer selection is manual
        · No exact tap/hold or physical-position detection
      </footer>
    </div>
  );
}
