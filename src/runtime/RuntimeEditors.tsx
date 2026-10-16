import { useContext, useEffect, useRef, useState } from "react";
import type {
  Keymap,
  PhysicalLayout as Layout,
  BehaviorBinding,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { BehaviorMap } from "../keyboard/keymapBackup";
import { PhysicalLayout } from "../keyboard/PhysicalLayout";
import { BehaviorBindingPicker } from "../behaviors/BehaviorBindingPicker";
import { UndoRedoContext, UndoRedoResetContext } from "../undoRedo";
import { RuntimeContext } from "./context";
import { combo, macro } from "./client";
import {
  comboOverlaps,
  macroEncodedSize,
  macroReferences,
  runtimeMacroBehavior,
  textSteps,
  validateCombo,
  validateMacro,
} from "./model";
import { useModalRef } from "../misc/useModalRef";
import { call_rpc } from "../rpc/logging";
import { GlobalSettingsEditor } from "./GlobalSettingsEditor";
import { isSimpleKeyPress } from "../behaviors/virtualKeys";

const button = "rounded bg-base-300 px-3 py-2 disabled:opacity-50";
const input = "rounded bg-base-300 p-2";
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
interface Props {
  keymap: Keymap;
  layout: Layout;
  behaviors: BehaviorMap;
}

export function RuntimeEditors({ keymap, layout, behaviors }: Props) {
  const runtime = useContext(RuntimeContext);
  const undoRedo = useContext(UndoRedoContext);
  const resetHistory = useContext(UndoRedoResetContext);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"combos" | "macros">("combos");
  const [selectedCombo, setSelectedCombo] = useState<combo.Combo>();
  const [selectedMacro, setSelectedMacro] = useState<macro.MacroDetail>();
  const comboBaseline = useRef<combo.Combo>();
  const macroBaseline = useRef<macro.MacroDetail>();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const dialog = useModalRef(open);
  const disabled = busy || runtime.busy || !runtime.client;
  const layers = keymap.layers.map(({ id, name }, index) => ({
    id,
    name: name || `Layer ${index + 1}`,
  }));
  const macroBehavior = runtimeMacroBehavior(behaviors);
  const defaultBehaviorId =
    runtime.snapshot.macros?.settings.keyPressBehaviorId ??
    Object.values(behaviors).find(isSimpleKeyPress)?.id ??
    Number(Object.keys(behaviors)[0]);
  const defaultBinding: BehaviorBinding = {
    behaviorId: defaultBehaviorId,
    param1:
      behaviors[defaultBehaviorId] &&
      isSimpleKeyPress(behaviors[defaultBehaviorId])
        ? (7 << 16) | 4
        : 0,
    param2: 0,
  };
  useEffect(() => {
    setSelectedCombo(undefined);
    setSelectedMacro(undefined);
    setOpen(false);
  }, [runtime.client]);

  const operation = async (action: () => Promise<void>, history = false) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      if (history) await action();
      else await runtime.run(action);
      await runtime.reload();
      setStatus(
        "Effective definitions reloaded. Save retains memory edits; confirmed persistent deletes/resets cannot be discarded.",
      );
    } catch (cause) {
      setError(
        `${message(cause)} Inspect/reload definitions before saving after any interrupted update.`,
      );
      try {
        await runtime.reload();
      } catch (refreshError) {
        setError(
          `${message(cause)} Reload also failed: ${message(refreshError)}`,
        );
      }
    } finally {
      setBusy(false);
    }
  };
  const freshKeymap = async () => {
    if (!runtime.client) throw new Error("Runtime editor is unavailable.");
    runtime.client.guard();
    const response = await call_rpc(runtime.client.connection, {
      keymap: { getKeymap: true },
    });
    if (!response.keymap?.getKeymap)
      throw new Error("Could not read key references.");
    return response.keymap.getKeymap;
  };
  const assertUnreferenced = async (definition: macro.MacroDetail) => {
    const snapshot = await runtime.client!.snapshot();
    const fresh = snapshot.macros?.definitions.find(
      (item) => item.name === definition.name,
    );
    if (!fresh || fresh.slot !== definition.slot)
      throw new Error("Macro identity changed; reload.");
    const references = macroReferences(
      definition.slot,
      macroBehavior,
      await freshKeymap(),
      snapshot,
    );
    if (references.length)
      throw new Error(
        `Clear references before deleting, renaming, or resetting: ${references.join("; ")}.`,
      );
  };
  const applyCombo = () =>
    operation(async () => {
      if (!selectedCombo || !runtime.client || !undoRedo) return;
      const client = runtime.client;
      const old = (await client.snapshot()).combos?.definitions.find(
        (item) => item.index === selectedCombo.index,
      );
      if (!old) throw new Error("Combo slot changed; reload.");
      if (
        comboBaseline.current &&
        JSON.stringify(old) !== JSON.stringify(comboBaseline.current)
      )
        throw new Error(
          "Effective combo changed since this draft was opened. Select the slot again before applying.",
        );
      validateCombo(
        selectedCombo,
        runtime.snapshot,
        layout.keys.length,
        behaviors,
        layers.map((layer) => layer.id),
      );
      const next = structuredClone(selectedCombo);
      await undoRedo(async () =>
        runtime.run(async () => {
          try {
            await client.putCombo(next);
          } catch (cause) {
            try {
              await client.putCombo(old);
            } catch (rollback) {
              throw new Error(
                `${message(cause)} Combo rollback incomplete: ${message(rollback)}`,
              );
            }
            throw cause;
          }
          await runtime.reload();
          comboBaseline.current = (
            await client.snapshot()
          ).combos?.definitions.find((item) => item.index === next.index);
          return async () =>
            runtime.run(async () => {
              await client.putCombo(old);
              await runtime.reload();
            });
        }),
      );
    }, true);
  const applyMacro = () =>
    operation(async () => {
      if (!selectedMacro || !runtime.client || !undoRedo) return;
      const client = runtime.client;
      const old = (await client.snapshot()).macros?.definitions.find(
        (item) => item.name === selectedMacro.name,
      );
      if (!old || old.slot !== selectedMacro.slot)
        throw new Error("Macro identity changed; reload.");
      if (
        macroBaseline.current &&
        JSON.stringify(old) !== JSON.stringify(macroBaseline.current)
      )
        throw new Error(
          "Effective macro changed since this draft was opened. Select it again before applying.",
        );
      validateMacro(
        selectedMacro,
        runtime.snapshot,
        behaviors,
        layers.map((layer) => layer.id),
      );
      const next = structuredClone(selectedMacro);
      await undoRedo(async () =>
        runtime.run(async () => {
          try {
            await client.putMacro(next);
          } catch (cause) {
            try {
              await client.putMacro(old);
            } catch (rollback) {
              throw new Error(
                `${message(cause)} Macro rollback incomplete: ${message(rollback)}`,
              );
            }
            throw cause;
          }
          await runtime.reload();
          macroBaseline.current = (
            await client.snapshot()
          ).macros?.definitions.find((item) => item.name === next.name);
          return async () =>
            runtime.run(async () => {
              await client.putMacro(old);
              await runtime.reload();
            });
        }),
      );
    }, true);
  const createMacro = () =>
    operation(async () => {
      const client = runtime.client!;
      const snapshot = await client.snapshot();
      const capacity = snapshot.macros;
      if (!capacity) throw new Error("Runtime macros are unavailable.");
      if (capacity.definitions.length >= capacity.settings.maxEntries)
        throw new Error("All macro slots are occupied.");
      if (capacity.definitions.some((item) => item.name === name))
        throw new Error("Macro name already exists.");
      validateMacro(
        { slot: 0, name, encodedSize: 1, steps: [] },
        snapshot,
        behaviors,
      );
      const map = await freshKeymap();
      for (let slot = 0; slot < capacity.settings.maxEntries; slot++)
        if (
          !capacity.definitions.some((item) => item.slot === slot) &&
          macroReferences(slot, macroBehavior, map, snapshot).length
        )
          throw new Error(
            `Unused slot ${slot} still has references. Clear them before creating a macro.`,
          );
      await client.macro({ createMacro: { name, persist: false } });
      const created = (await client.snapshot()).macros?.definitions.find(
        (item) => item.name === name,
      );
      if (!created) throw new Error("Created macro could not be read back.");
      setSelectedMacro(created);
      macroBaseline.current = created;
    });
  const mutateSteps = (steps: macro.MacroStep[]) => {
    if (selectedMacro) setSelectedMacro({ ...selectedMacro, steps });
  };
  const changeStep = (index: number, step: macro.MacroStep) => {
    if (selectedMacro)
      mutateSteps(
        selectedMacro.steps.map((old, position) =>
          position === index ? step : old,
        ),
      );
  };

  return (
    <>
      <button
        className={button}
        disabled={
          disabled || (!runtime.snapshot.combos && !runtime.snapshot.macros)
        }
        onClick={() => {
          setTab(runtime.snapshot.combos ? "combos" : "macros");
          setOpen(true);
        }}
      >
        Runtime Combos / Macros
      </button>
      {runtime.error && <p role="alert">{runtime.error}</p>}
      {!runtime.busy &&
        runtime.client &&
        !runtime.snapshot.combos &&
        !runtime.snapshot.macros && (
          <p className="text-sm">
            Runtime editors unsupported by this firmware.
          </p>
        )}
      <dialog
        ref={dialog}
        aria-labelledby="runtime-title"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        className="bg-base-100 text-base-content rounded p-5 w-[95vw] max-w-6xl max-h-[95vh] overflow-auto backdrop:bg-[rgba(0,0,0,0.5)]"
      >
        <h2 id="runtime-title" className="text-lg">
          Runtime Combos and Macros
        </h2>
        <GlobalSettingsEditor />
        <p>
          Apply edits changes RAM only; use the main Save / Discard controls for
          persistence. Firmware has no multi-operation transaction. Default
          resets and macro deletion have separate irreversible storage effects.
        </p>
        <div className="flex gap-2 my-3">
          <button
            className={button}
            disabled={!runtime.snapshot.combos || disabled}
            onClick={() => setTab("combos")}
          >
            Combos
          </button>
          <button
            className={button}
            disabled={!runtime.snapshot.macros || disabled}
            onClick={() => setTab("macros")}
          >
            Macros
          </button>
          <button
            className={button}
            disabled={disabled}
            onClick={() =>
              void operation(async () => {
                setSelectedCombo(undefined);
                setSelectedMacro(undefined);
              })
            }
          >
            Reload effective definitions
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Close
          </button>
        </div>
        {error && (
          <p role="alert" className="text-error">
            {error}
          </p>
        )}
        {status && <p role="status">{status}</p>}
        <fieldset disabled={disabled} className="min-w-0">
          {tab === "combos" && runtime.snapshot.combos && (
            <>
              <p>
                {runtime.snapshot.combos.settings.maxCombo} slots; maximum 4
                physical positions/combo (firmware profile). Global timeout{" "}
                {runtime.snapshot.combos.settings.timeoutMs} ms, prior idle{" "}
                {runtime.snapshot.combos.settings.requirePriorIdleMs} ms, slow
                release{" "}
                {runtime.snapshot.combos.settings.slowRelease ? "on" : "off"}.
              </p>
              <div className="flex flex-wrap gap-2 my-3">
                {runtime.snapshot.combos.definitions.map((item) => (
                  <button
                    key={item.index}
                    className={button}
                    onClick={() => {
                      comboBaseline.current = structuredClone(item);
                      setSelectedCombo({
                        ...structuredClone(item),
                        behavior:
                          item.keyPositions.length && item.behavior
                            ? item.behavior
                            : defaultBinding,
                      });
                    }}
                  >
                    {item.index}: {item.name || "(empty)"} [
                    {combo.ComboSource[item.source]
                      ?.replace("COMBO_SOURCE_", "")
                      .toLowerCase() ?? "unknown"}
                    ]{item.enabled ? "" : " (disabled)"}
                  </button>
                ))}
              </div>
              {selectedCombo && (
                <>
                  <label>
                    Name{" "}
                    <input
                      className={input}
                      value={selectedCombo.name}
                      onChange={(event) =>
                        setSelectedCombo({
                          ...selectedCombo,
                          name: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="ml-3">
                    <input
                      type="checkbox"
                      checked={selectedCombo.enabled}
                      onChange={(event) =>
                        setSelectedCombo({
                          ...selectedCombo,
                          enabled: event.target.checked,
                        })
                      }
                    />{" "}
                    Enabled
                  </label>
                  <p>
                    Click physical keys to toggle:{" "}
                    {selectedCombo.keyPositions
                      .map((position) => position + 1)
                      .join(", ") || "none"}
                  </p>
                  <div className="overflow-auto p-2" style={{ minHeight: 180 }}>
                    <PhysicalLayout
                      positions={layout.keys.map((key, position) => ({
                        id: String(position),
                        x: key.x / 100,
                        y: key.y / 100,
                        width: key.width / 100,
                        height: key.height / 100,
                        r: key.r / 100,
                        rx: key.rx / 100,
                        ry: key.ry / 100,
                        children: (
                          <span
                            className={
                              selectedCombo.keyPositions.includes(position)
                                ? "bg-primary text-primary-content rounded px-2"
                                : ""
                            }
                          >
                            {position + 1}
                            {selectedCombo.keyPositions.includes(position)
                              ? " [X]"
                              : ""}
                          </span>
                        ),
                      }))}
                      onPositionClicked={(position) =>
                        setSelectedCombo({
                          ...selectedCombo,
                          keyPositions: selectedCombo.keyPositions.includes(
                            position,
                          )
                            ? selectedCombo.keyPositions.filter(
                                (key) => key !== position,
                              )
                            : [...selectedCombo.keyPositions, position],
                        })
                      }
                    />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <label>
                      Timeout ms (0 inherits){" "}
                      <input
                        type="number"
                        min="0"
                        className={input}
                        value={selectedCombo.timeoutMs}
                        onChange={(event) =>
                          setSelectedCombo({
                            ...selectedCombo,
                            timeoutMs: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Prior idle ms (0 inherits){" "}
                      <input
                        type="number"
                        min="0"
                        className={input}
                        value={selectedCombo.requirePriorIdleMs}
                        onChange={(event) =>
                          setSelectedCombo({
                            ...selectedCombo,
                            requirePriorIdleMs: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Slow release{" "}
                      <select
                        className={input}
                        value={selectedCombo.slowReleaseOverride}
                        onChange={(event) =>
                          setSelectedCombo({
                            ...selectedCombo,
                            slowReleaseOverride: Number(event.target.value),
                          })
                        }
                      >
                        <option value={0}>Inherit</option>
                        <option value={1}>On</option>
                        <option value={2}>Off</option>
                      </select>
                    </label>
                  </div>
                  <p>Active layers (none selected means all layers):</p>
                  <div className="flex gap-3">
                    {layers.map((layer, index) => (
                      <label key={layer.id}>
                        <input
                          type="checkbox"
                          checked={
                            (selectedCombo.layerMask & (1 << index)) !== 0
                          }
                          onChange={() =>
                            setSelectedCombo({
                              ...selectedCombo,
                              layerMask:
                                (selectedCombo.layerMask ^ (1 << index)) >>> 0,
                            })
                          }
                        />{" "}
                        {layer.name}
                      </label>
                    ))}
                  </div>
                  <BehaviorBindingPicker
                    binding={selectedCombo.behavior ?? defaultBinding}
                    behaviors={Object.values(behaviors)}
                    layers={layers}
                    onBindingChanged={(behavior) =>
                      setSelectedCombo({ ...selectedCombo, behavior })
                    }
                  />
                  {comboOverlaps(
                    selectedCombo,
                    runtime.snapshot.combos.definitions,
                  ).length > 0 && (
                    <p role="status">
                      Overlap warning:{" "}
                      {comboOverlaps(
                        selectedCombo,
                        runtime.snapshot.combos.definitions,
                      ).join(", ")}
                      . Shared keys may make activation ambiguous.
                    </p>
                  )}
                  <div className="flex gap-2 my-3">
                    <button
                      className={button}
                      onClick={() => void applyCombo()}
                    >
                      Apply combo in memory
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        void operation(async () => {
                          if (!undoRedo)
                            throw new Error("Undo history is unavailable.");
                          const client = runtime.client!;
                          const prior = (
                            await client.snapshot()
                          ).combos?.definitions.find(
                            (item) => item.index === selectedCombo.index,
                          );
                          if (!prior)
                            throw new Error("Combo slot changed; reload.");
                          await undoRedo(async () =>
                            runtime.run(async () => {
                              await client.combo({
                                deleteCombo: {
                                  index: prior.index,
                                  persist: false,
                                },
                              });
                              await runtime.reload();
                              return async () =>
                                runtime.run(async () => {
                                  await client.putCombo(prior);
                                  await runtime.reload();
                                });
                            }),
                          );
                          setSelectedCombo(undefined);
                        }, true)
                      }
                    >
                      Delete / disable combo
                    </button>
                    <button
                      className={button}
                      onClick={() => {
                        if (
                          window.confirm(
                            "Reset this slot to its compiled default? This erases its saved override immediately, cannot be undone or discarded.",
                          )
                        )
                          void operation(async () => {
                            await runtime.client!.combo({
                              resetCombo: { index: selectedCombo.index },
                            });
                            resetHistory();
                            setSelectedCombo(undefined);
                          });
                      }}
                    >
                      Reset compiled default (persistent)
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {tab === "macros" && runtime.snapshot.macros && (
            <>
              <p>
                Macro default origin: not advertised by this RPC schema. Reset
                restores a matching compiled default or removes a runtime-only
                macro.
              </p>
              <p>
                {runtime.snapshot.macros.definitions.length}/
                {runtime.snapshot.macros.settings.maxEntries} slots;{" "}
                {runtime.snapshot.macros.settings.poolBytesUsed}/
                {runtime.snapshot.macros.settings.poolBytesTotal} RAM bytes; max
                body {runtime.snapshot.macros.maxBytes} bytes; max name{" "}
                {runtime.snapshot.macros.maxNameLength} UTF-8 bytes. Tap
                duration {runtime.snapshot.macros.settings.tapMs} ms.
              </p>
              <div className="flex flex-wrap gap-2 my-3">
                {runtime.snapshot.macros.definitions.map((item) => (
                  <button
                    key={item.slot}
                    className={button}
                    onClick={() => {
                      setSelectedMacro(structuredClone(item));
                      macroBaseline.current = structuredClone(item);
                      setName(item.name);
                    }}
                  >
                    {item.name} (slot {item.slot}, {item.encodedSize} bytes)
                    {runtime.snapshot.macros!.summaries.find(
                      (summary) => summary.slot === item.slot,
                    )?.hasUnsavedChanges
                      ? " *unsaved"
                      : ""}
                  </button>
                ))}
              </div>
              <label>
                Macro name{" "}
                <input
                  className={input}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                className={`${button} ml-2`}
                onClick={() => void createMacro()}
              >
                Create empty macro
              </button>
              {selectedMacro && (
                <>
                  <h3 className="my-3">
                    {selectedMacro.name} -{" "}
                    {macroEncodedSize(selectedMacro.steps)} encoded bytes
                  </h3>
                  <p>
                    References:{" "}
                    {macroReferences(
                      selectedMacro.slot,
                      macroBehavior,
                      keymap,
                      runtime.snapshot,
                    ).join("; ") || "none"}
                    . Rename/delete/reset are blocked until all references are
                    cleared.
                  </p>
                  <div className="flex gap-2">
                    <button
                      className={button}
                      onClick={() =>
                        void operation(async () => {
                          await assertUnreferenced(selectedMacro);
                          validateMacro(
                            { ...selectedMacro, name },
                            runtime.snapshot,
                            behaviors,
                            layers.map((layer) => layer.id),
                          );
                          if (
                            !window.confirm(
                              "Rename may move this macro to a different slot and erase its old stored name immediately. Continue?",
                            )
                          )
                            return;
                          await runtime.client!.macro({
                            renameMacro: {
                              oldName: selectedMacro.name,
                              newName: name,
                              persist: false,
                            },
                          });
                          resetHistory();
                          setSelectedMacro(undefined);
                        })
                      }
                    >
                      Rename unreferenced macro
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        void operation(async () => {
                          await assertUnreferenced(selectedMacro);
                          if (
                            !window.confirm(
                              "Delete this unreferenced macro? Its persisted record is erased immediately; Discard cannot restore it.",
                            )
                          )
                            return;
                          await runtime.client!.macro({
                            deleteMacro: { name: selectedMacro.name },
                          });
                          resetHistory();
                          setSelectedMacro(undefined);
                        })
                      }
                    >
                      Delete (persistent)
                    </button>
                    <button
                      className={button}
                      onClick={() =>
                        void operation(async () => {
                          await assertUnreferenced(selectedMacro);
                          if (
                            !window.confirm(
                              "Reset to the compiled default, or remove this macro if no default exists? Removal erases its persisted record immediately and cannot be restored by Discard.",
                            )
                          )
                            return;
                          await runtime.client!.macro({
                            resetMacro: {
                              slot: selectedMacro.slot,
                              persist: false,
                            },
                          });
                          resetHistory();
                          setSelectedMacro(undefined);
                        })
                      }
                    >
                      Reset compiled default / remove
                    </button>
                  </div>
                  {selectedMacro.steps.map((step, index) => {
                    const kind = step.down
                      ? "down"
                      : step.up
                        ? "up"
                        : step.tap
                          ? "tap"
                          : step.delay
                            ? "delay"
                            : "keyTapSequence";
                    const binding = step.down ?? step.up ?? step.tap;
                    return (
                      <div
                        key={index}
                        className="border border-base-300 p-2 my-2"
                      >
                        <span>Step {index + 1} </span>
                        <select
                          className={input}
                          value={kind}
                          onChange={(event) => {
                            const type = event.target.value;
                            changeStep(
                              index,
                              type === "delay"
                                ? { delay: { delayMs: 100 } }
                                : type === "down"
                                  ? { down: binding ?? defaultBinding }
                                  : type === "up"
                                    ? { up: binding ?? defaultBinding }
                                    : { tap: binding ?? defaultBinding },
                            );
                          }}
                        >
                          <option value="tap">Tap</option>
                          <option value="down">Press</option>
                          <option value="up">Release</option>
                          <option value="delay">Delay</option>
                          {kind === "keyTapSequence" && (
                            <option value="keyTapSequence">
                              Packed text (preserved)
                            </option>
                          )}
                        </select>
                        <button
                          className={`${button} ml-2`}
                          disabled={index === 0}
                          onClick={() => {
                            const steps = [...selectedMacro.steps];
                            [steps[index - 1], steps[index]] = [
                              steps[index],
                              steps[index - 1],
                            ];
                            mutateSteps(steps);
                          }}
                        >
                          Move up
                        </button>
                        <button
                          className={`${button} ml-2`}
                          disabled={index === selectedMacro.steps.length - 1}
                          onClick={() => {
                            const steps = [...selectedMacro.steps];
                            [steps[index + 1], steps[index]] = [
                              steps[index],
                              steps[index + 1],
                            ];
                            mutateSteps(steps);
                          }}
                        >
                          Move down
                        </button>
                        <button
                          className={`${button} ml-2`}
                          onClick={() =>
                            mutateSteps(
                              selectedMacro.steps.filter(
                                (_, position) => position !== index,
                              ),
                            )
                          }
                        >
                          Remove step
                        </button>
                        {step.delay && (
                          <label>
                            Delay ms{" "}
                            <input
                              className={input}
                              type="number"
                              min="0"
                              value={step.delay.delayMs}
                              onChange={(event) =>
                                changeStep(index, {
                                  delay: {
                                    delayMs: Number(event.target.value),
                                  },
                                })
                              }
                            />
                          </label>
                        )}
                        {binding && (
                          <BehaviorBindingPicker
                            binding={binding}
                            behaviors={Object.values(behaviors)}
                            layers={layers}
                            onBindingChanged={(value) =>
                              changeStep(
                                index,
                                kind === "down"
                                  ? { down: value }
                                  : kind === "up"
                                    ? { up: value }
                                    : { tap: value },
                              )
                            }
                          />
                        )}
                        {step.keyTapSequence && (
                          <p>
                            {step.keyTapSequence.packedKeys.length} compact US
                            key taps. Preserved unchanged unless replaced.
                          </p>
                        )}
                      </div>
                    );
                  })}
                  <button
                    className={button}
                    onClick={() =>
                      mutateSteps([
                        ...selectedMacro.steps,
                        { tap: defaultBinding },
                      ])
                    }
                  >
                    Add step
                  </button>
                  <label className="block my-3">
                    Text shortcut (US ASCII; host keyboard layout dependent)
                    <textarea
                      className={`${input} block w-full`}
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                  </label>
                  <button
                    className={button}
                    onClick={() => {
                      try {
                        mutateSteps([
                          ...selectedMacro.steps,
                          ...textSteps(
                            text,
                            runtime.snapshot.macros!.settings
                              .keyPressBehaviorId,
                          ),
                        ]);
                        setText("");
                        setError(undefined);
                      } catch (cause) {
                        setError(message(cause));
                      }
                    }}
                  >
                    Append text taps
                  </button>
                  <button
                    className={`${button} ml-2`}
                    onClick={() => void applyMacro()}
                  >
                    Apply macro in memory
                  </button>
                </>
              )}
            </>
          )}
        </fieldset>
      </dialog>
    </>
  );
}
