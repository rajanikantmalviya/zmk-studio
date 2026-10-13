import { useState } from "react";
import { hid_usage_get_labels } from "../hid-usages";
import { HidUsagePage, isUsageAllowed, virtualKeyboards } from "./virtualKeys";

interface VirtualKeyboardProps {
  value?: number;
  usagePages: HidUsagePage[];
  onValueChanged: (value: number) => void;
}

export function VirtualKeyboard({
  value,
  usagePages,
  onValueChanged,
}: VirtualKeyboardProps) {
  const [category, setCategory] = useState("Keyboard");
  return (
    <div className="min-w-0">
      <div className="flex gap-1 mb-2" role="group" aria-label="Key categories">
        {Object.keys(virtualKeyboards).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={category === name}
            onClick={() => setCategory(name)}
            className={`rounded px-3 py-1 ${category === name ? "bg-primary text-primary-content" : "bg-base-300 hover:bg-base-100"}`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto pb-1">
        <div
          className={`flex flex-col gap-1 ${category === "Numpad" ? "w-80" : "min-w-[640px]"}`}
          role="group"
          aria-label={`${category} key palette`}
        >
          {virtualKeyboards[category].map((row, index) => (
            <div key={index} className="flex gap-1">
              {row.map((key) => {
                const selected =
                  value !== undefined && (value & 0x00ffffff) === key.usage;
                const labels = hid_usage_get_labels(
                  key.usage >>> 16,
                  key.usage & 0xffff,
                );
                return (
                  <button
                    key={key.usage}
                    type="button"
                    aria-label={key.label}
                    aria-pressed={selected}
                    title={
                      labels.long ?? labels.med ?? labels.short ?? key.label
                    }
                    disabled={!isUsageAllowed(key.usage, usagePages)}
                    style={{ flex: `${key.width} ${key.width} 0` }}
                    onClick={() => onValueChanged(key.usage)}
                    className={`h-8 min-w-0 rounded border border-base-content/20 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-30 disabled:cursor-not-allowed ${selected ? "bg-primary text-primary-content" : "bg-base-100 hover:bg-base-300"}`}
                  >
                    {key.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
