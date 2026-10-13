import { useEffect, useMemo, useRef, useState } from "react";
import {
  GetBehaviorDetailsResponse,
  BehaviorBindingParametersSet,
} from "@zmkfirmware/zmk-studio-ts-client/behaviors";
import { BehaviorBinding } from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { BehaviorParametersPicker } from "./BehaviorParametersPicker";
import { validateValue } from "./parameters";
import { HidUsagePicker } from "./HidUsagePicker";
import { isSimpleKeyPress } from "./virtualKeys";

export interface BehaviorBindingPickerProps {
  binding: BehaviorBinding;
  behaviors: GetBehaviorDetailsResponse[];
  layers: { id: number; name: string }[];
  onBindingChanged: (binding: BehaviorBinding) => void;
  isDisabled?: boolean;
}

function validateBinding(
  metadata: BehaviorBindingParametersSet[],
  layerIds: number[],
  param1?: number,
  param2?: number,
): boolean {
  if (metadata.length === 0) {
    return (
      (param1 === undefined || param1 === 0) &&
      (param2 === undefined || param2 === 0)
    );
  }
  return metadata.some(
    (set) =>
      validateValue(layerIds, param1, set.param1) &&
      validateValue(layerIds, param2, set.param2),
  );
}

export const BehaviorBindingPicker = ({
  binding,
  layers,
  behaviors,
  onBindingChanged,
  isDisabled = false,
}: BehaviorBindingPickerProps) => {
  const [behaviorId, setBehaviorId] = useState(binding.behaviorId);
  const [param1, setParam1] = useState<number | undefined>(binding.param1);
  const [param2, setParam2] = useState<number | undefined>(binding.param2);
  const [mode, setMode] = useState("keys");
  const dirty = useRef(false);
  const metadata = useMemo(
    () => behaviors.find((b) => b.id === behaviorId)?.metadata,
    [behaviorId, behaviors],
  );
  const sortedBehaviors = useMemo(
    () =>
      [...behaviors].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [behaviors],
  );

  useEffect(() => {
    dirty.current = false;
    setBehaviorId(binding.behaviorId);
    setParam1(binding.param1);
    setParam2(binding.param2);
  }, [binding]);

  useEffect(() => {
    if (!dirty.current || isDisabled || !metadata) return;
    if (
      binding.behaviorId === behaviorId &&
      binding.param1 === param1 &&
      binding.param2 === param2
    ) {
      dirty.current = false;
      return;
    }
    if (
      validateBinding(
        metadata,
        layers.map(({ id }) => id),
        param1,
        param2,
      )
    ) {
      dirty.current = false;
      onBindingChanged({
        behaviorId,
        param1: param1 ?? 0,
        param2: param2 ?? 0,
      });
    }
  }, [
    behaviorId,
    param1,
    param2,
    binding,
    metadata,
    layers,
    onBindingChanged,
    isDisabled,
  ]);

  const keyBehaviors = behaviors.filter(isSimpleKeyPress);
  const keyBehavior =
    keyBehaviors.find((behavior) => behavior.id === behaviorId) ??
    keyBehaviors.find(
      (behavior) => behavior.displayName.toLowerCase() === "key press",
    ) ??
    (keyBehaviors.length === 1 ? keyBehaviors[0] : undefined);
  const keyUsage = keyBehavior?.metadata[0].param1[0].hidUsage;

  return (
    <fieldset disabled={isDisabled} className="flex flex-col gap-2 min-w-0">
      <div
        className="flex gap-2 items-center"
        role="group"
        aria-label="Binding editor"
      >
        <button
          type="button"
          aria-pressed={mode === "keys"}
          className={`rounded px-3 py-1 ${mode === "keys" ? "bg-primary text-primary-content" : "bg-base-300"}`}
          onClick={() => setMode("keys")}
        >
          Virtual keyboard
        </button>
        <button
          type="button"
          aria-pressed={mode === "advanced"}
          className={`rounded px-3 py-1 ${mode === "advanced" ? "bg-primary text-primary-content" : "bg-base-300"}`}
          onClick={() => setMode("advanced")}
        >
          Advanced
        </button>
        {isDisabled && <span role="status">Updating...</span>}
      </div>
      {mode === "keys" ? (
        <>
          <p className="text-[12px]">
            Click a key below to assign it to the selected keyboard position.
            Use the modifier toggles for combinations such as Ctrl+C.
          </p>
          {keyBehavior && keyUsage ? (
            <HidUsagePicker
              label="Key code"
              value={behaviorId === keyBehavior.id ? param1 : undefined}
              usagePages={[
                { id: 7, min: 4, max: keyUsage.keyboardMax },
                { id: 12, max: keyUsage.consumerMax },
              ]}
              onValueChanged={(value) => {
                dirty.current = true;
                setBehaviorId(keyBehavior.id);
                setParam1(value);
                setParam2(0);
              }}
            />
          ) : (
            <div>
              <p>
                No unambiguous key-press behavior is selected. Choose one below
                or use Advanced.
              </p>
              <select
                aria-label="Key press behavior"
                value=""
                onChange={(event) => {
                  dirty.current = true;
                  setBehaviorId(Number(event.target.value));
                  setParam1(undefined);
                  setParam2(0);
                }}
              >
                <option value="" disabled>
                  Choose key press behavior
                </option>
                {keyBehaviors.map((behavior) => (
                  <option key={behavior.id} value={behavior.id}>
                    {behavior.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}
        </>
      ) : (
        <>
          <div>
            <label>Behavior: </label>
            <select
              value={behaviorId}
              className="h-8 rounded"
              onChange={(event) => {
                dirty.current = true;
                setBehaviorId(Number(event.target.value));
                setParam1(0);
                setParam2(0);
              }}
            >
              {sortedBehaviors.map((behavior) => (
                <option key={behavior.id} value={behavior.id}>
                  {behavior.displayName}
                </option>
              ))}
            </select>
          </div>
          {metadata && (
            <BehaviorParametersPicker
              metadata={metadata}
              param1={param1}
              param2={param2}
              layers={layers}
              onParam1Changed={(value) => {
                dirty.current = true;
                setParam1(value);
              }}
              onParam2Changed={(value) => {
                dirty.current = true;
                setParam2(value);
              }}
            />
          )}
        </>
      )}
    </fieldset>
  );
};
