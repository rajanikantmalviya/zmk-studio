import { useContext, useEffect, useState } from "react";
import { RuntimeContext } from "./context";
import { UndoRedoContext } from "../undoRedo";

export function GlobalSettingsEditor() {
  const runtime = useContext(RuntimeContext);
  const history = useContext(UndoRedoContext);
  const [timeoutMs, setTimeoutMs] = useState(50);
  const [priorIdleMs, setPriorIdleMs] = useState(0);
  const [slowRelease, setSlowRelease] = useState(false);
  const [tapMs, setTapMs] = useState(5);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const combos = runtime.snapshot.combos?.settings;
    const macros = runtime.snapshot.macros?.settings;
    if (combos) {
      setTimeoutMs(combos.timeoutMs);
      setPriorIdleMs(combos.requirePriorIdleMs);
      setSlowRelease(combos.slowRelease);
    }
    if (macros) setTapMs(macros.tapMs);
  }, [runtime.snapshot]);

  const apply = async () => {
    const client = runtime.client;
    if (!client || !history) return;
    setError(undefined);
    const describe = (cause: unknown) =>
      cause instanceof Error ? cause.message : String(cause);
    try {
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 65535 ||
        !Number.isInteger(priorIdleMs) ||
        priorIdleMs < 0 ||
        priorIdleMs > 65535 ||
        !Number.isInteger(tapMs) ||
        tapMs < 0 ||
        tapMs > 10000
      )
        throw new Error(
          "Timeout must be 1-65535 ms; prior idle 0-65535 ms; tap duration 0-10000 ms.",
        );
      await history(async () =>
        runtime.run(async () => {
          const before = await client.snapshot();
          const put = async (
            timeout: number,
            idle: number,
            slow: boolean,
            tap: number,
          ) => {
            if (before.combos) {
              await client.combo({
                setTimeoutMs: { timeoutMs: timeout, persist: false },
              });
              await client.combo({
                setRequirePriorIdleMs: {
                  requirePriorIdleMs: idle,
                  persist: false,
                },
              });
              await client.combo({
                setSlowRelease: { slowRelease: slow, persist: false },
              });
            }
            if (before.macros)
              await client.macro({ setTapMs: { tapMs: tap, persist: false } });
          };
          const undo = async () => {
            await put(
              before.combos?.settings.timeoutMs ?? 50,
              before.combos?.settings.requirePriorIdleMs ?? 0,
              before.combos?.settings.slowRelease ?? false,
              before.macros?.settings.tapMs ?? 5,
            );
            await runtime.reload();
          };
          try {
            await put(timeoutMs, priorIdleMs, slowRelease, tapMs);
          } catch (cause) {
            try {
              await undo();
            } catch (rollback) {
              throw new Error(
                `${describe(cause)} Global timing rollback incomplete: ${describe(rollback)}`,
              );
            }
            throw cause;
          }
          await runtime.reload();
          return () => runtime.run(undo);
        }),
      );
    } catch (cause) {
      setError(`${describe(cause)} Inspect effective settings before saving.`);
    }
  };
  return (
    <details className="my-3">
      <summary>Global runtime timing (in-memory edits)</summary>
      <fieldset
        disabled={runtime.busy || !runtime.client}
        className="flex flex-wrap gap-3 my-2"
      >
        {runtime.snapshot.combos && (
          <>
            <label>
              Combo timeout ms{" "}
              <input
                type="number"
                min="1"
                max="65535"
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
                className="bg-base-300 rounded p-2"
              />
            </label>
            <label>
              Prior idle ms{" "}
              <input
                type="number"
                min="0"
                max="65535"
                value={priorIdleMs}
                onChange={(event) => setPriorIdleMs(Number(event.target.value))}
                className="bg-base-300 rounded p-2"
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={slowRelease}
                onChange={(event) => setSlowRelease(event.target.checked)}
              />{" "}
              Slow release
            </label>
          </>
        )}
        {runtime.snapshot.macros && (
          <label>
            Macro tap ms{" "}
            <input
              type="number"
              min="0"
              max="10000"
              value={tapMs}
              onChange={(event) => setTapMs(Number(event.target.value))}
              className="bg-base-300 rounded p-2"
            />
          </label>
        )}
        <button
          className="bg-base-300 rounded px-3 py-2"
          onClick={() => void apply()}
        >
          Apply global timing in memory
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </details>
  );
}
