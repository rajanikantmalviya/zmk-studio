import { useEffect, useMemo, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { GetBehaviorDetailsResponse } from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import type {
  Keymap,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import {
  setOverlayConfiguration,
  supportsWindowsOverlay,
} from "../tauri/overlay";
import {
  buildOverlayLayers,
  createLearningSession,
  DEFAULT_OVERLAY_SIZE_PERCENT,
  LearningMode,
  LearningRequest,
  OverlayConfiguration,
  OVERLAY_SIZE_STEP,
} from "./model";

interface LearningProgress {
  sessionId: string;
  correct: number;
  attempts: number;
  total: number;
  feedback: string;
}

interface KeyboardOverlayControlsProps {
  keymap: Keymap;
  layout: PhysicalLayout;
  behaviors: Record<number, GetBehaviorDetailsResponse>;
  deviceName: string;
}

export function KeyboardOverlayControls({
  keymap,
  layout,
  behaviors,
  deviceName,
}: KeyboardOverlayControlsProps) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sizePercent, setSizePercent] = useState(DEFAULT_OVERLAY_SIZE_PERCENT);
  const [layerId, setLayerId] = useState(keymap.layers[0].id);
  const [mode, setMode] = useState<LearningMode>("find-key");
  const [hints, setHints] = useState(true);
  const [learning, setLearning] = useState<LearningRequest | null>(null);
  const [progress, setProgress] = useState<LearningProgress>();
  const [error, setError] = useState<string>();
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const layers = useMemo(
    () => buildOverlayLayers(keymap, layout, behaviors),
    [keymap, layout, behaviors],
  );
  const layer =
    layers.find((candidate) => candidate.id === layerId) ?? layers[0];
  const configuration = useMemo<OverlayConfiguration>(
    () => ({
      deviceName,
      sizePercent,
      layers,
      displayedLayerId: layer.id,
      learning,
    }),
    [deviceName, sizePercent, layers, layer.id, learning],
  );

  useEffect(() => {
    setLearning(null);
    setProgress(undefined);
  }, [layers]);

  useEffect(() => {
    if (!supportsWindowsOverlay) return;
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const initialize = async () => {
      const subscriptions: (() => Promise<UnlistenFn>)[] = [
        () =>
          listen<string>("keyboard-overlay-error", ({ payload }) => {
            if (disposed) return;
            setError(payload);
            setEnabled(false);
            setLearning(null);
          }),
        () =>
          listen("keyboard-overlay-closed", () => {
            if (disposed) return;
            setEnabled(false);
            setLearning(null);
          }),
        () =>
          listen<LearningProgress>(
            "keyboard-overlay-learning",
            ({ payload }) => {
              if (
                !disposed &&
                payload.sessionId === learningRef.current?.sessionId
              ) {
                setProgress(payload);
              }
            },
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
    };
    initialize().catch((cause) => {
      console.error("Could not initialize overlay controls", cause);
      if (!disposed) setError(String(cause));
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
      setOverlayConfiguration(null).catch((cause) => {
        console.error("Could not disable keyboard overlay", cause);
        window.alert(
          `Could not finish disabling the keyboard overlay: ${String(cause)}`,
        );
      });
    };
  }, []);

  useEffect(() => {
    if (!supportsWindowsOverlay) return;
    let canceled = false;
    setBusy(true);
    setOverlayConfiguration(enabled ? configuration : null)
      .then(() => {
        if (!canceled) setBusy(false);
      })
      .catch((cause) => {
        console.error("Could not update keyboard overlay", cause);
        if (!canceled) {
          setBusy(false);
          setError(String(cause));
          setEnabled(false);
          setLearning(null);
        }
      });
    return () => {
      canceled = true;
    };
  }, [enabled, configuration]);

  const startLearning = () => {
    const request: LearningRequest = {
      sessionId: crypto.randomUUID(),
      mode,
      count: 10,
      hints,
    };
    try {
      createLearningSession({ ...configuration, learning: request });
      setError(undefined);
      setProgress(undefined);
      setLearning(request);
    } catch (cause) {
      console.error("Could not start learning session", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="flex flex-col gap-2 max-w-64 border-t border-base-content/20 pt-2">
      <h2 className="font-semibold">Keyboard overlay &amp; learning</h2>
      <label className="flex items-start gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!supportsWindowsOverlay || busy}
          onChange={(event) => {
            setError(undefined);
            setEnabled(event.target.checked);
            if (!event.target.checked) {
              setLearning(null);
              setProgress(undefined);
            }
          }}
        />
        Enable Windows output overlay
      </label>
      {!supportsWindowsOverlay && (
        <p className="text-[12px]">
          Available in the Windows desktop app, not the browser.
        </p>
      )}
      <p className="text-[11px]">
        Bottom-center, always on top, click-through. Highlights output from all
        physical keyboards while enabled; does not record typed text.
      </p>
      <div className="text-[12px]">
        <span id="overlay-size-label">Keyboard size: {sizePercent}%</span>
        <div
          className="flex gap-2 mt-1"
          role="group"
          aria-labelledby="overlay-size-label"
        >
          <button
            type="button"
            className="rounded bg-base-100 hover:bg-base-300 px-2 py-1 disabled:opacity-50"
            disabled={
              !supportsWindowsOverlay ||
              busy ||
              sizePercent <= OVERLAY_SIZE_STEP
            }
            onClick={() =>
              setSizePercent((previous) => previous - OVERLAY_SIZE_STEP)
            }
          >
            Smaller (-10%)
          </button>
          <button
            type="button"
            className="rounded bg-base-100 hover:bg-base-300 px-2 py-1 disabled:opacity-50"
            disabled={!supportsWindowsOverlay || busy}
            onClick={() =>
              setSizePercent((previous) => previous + OVERLAY_SIZE_STEP)
            }
          >
            Bigger (+10%)
          </button>
        </div>
        <p className="text-[11px] mt-1">
          Defaults to 120%. Automatically fits within your screen.
        </p>
      </div>
      <label className="text-[12px]">
        Displayed layer (manual)
        <select
          className="block w-full rounded p-1"
          value={layer.id}
          disabled={!enabled || busy}
          onChange={(event) => {
            setLayerId(Number(event.target.value));
            setLearning(null);
            setProgress(undefined);
          }}
        >
          {layers.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[12px]">
        Learning session
        <select
          className="block w-full rounded p-1"
          value={mode}
          disabled={!enabled || busy}
          onChange={(event) => {
            setMode(
              event.target.value === "layer-drill" ? "layer-drill" : "find-key",
            );
          }}
        >
          <option value="find-key">Find the prompted key</option>
          <option value="layer-drill">Practice the displayed layer</option>
        </select>
      </label>
      <label className="flex gap-2 text-[12px]">
        <input
          type="checkbox"
          checked={hints}
          disabled={!enabled || busy}
          onChange={(event) => setHints(event.target.checked)}
        />
        Show target hints in new sessions
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-base-100 hover:bg-base-300 px-2 py-1 disabled:opacity-50"
          disabled={
            !enabled || busy || !layer.keys.some((key) => key.trainable)
          }
          onClick={(event) => {
            event.currentTarget.blur();
            startLearning();
          }}
        >
          Start 10 prompts
        </button>
        <button
          type="button"
          className="rounded bg-base-100 hover:bg-base-300 px-2 py-1 disabled:opacity-50"
          disabled={!learning || busy}
          onClick={() => {
            setLearning(null);
            setProgress(undefined);
          }}
        >
          Stop
        </button>
      </div>
      {progress && (
        <p role="status" className="text-[12px]">
          {progress.correct}/{progress.total} correct · {progress.attempts}{" "}
          attempts · {progress.feedback}
        </p>
      )}
      {busy && (
        <p role="status" className="text-[12px]">
          Updating overlay...
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-600 text-[12px]">
          {error}
        </p>
      )}
      <p className="text-[11px]">
        Layers are not detected automatically. Practice grades emitted keys, not
        physical positions or tap/hold decisions. Keystrokes still reach your
        focused app; use a scratch editor for learning.
      </p>
    </section>
  );
}
