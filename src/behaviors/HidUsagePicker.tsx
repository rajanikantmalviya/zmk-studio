import {
  Button,
  Checkbox,
  CheckboxGroup,
  Collection,
  ComboBox,
  Header,
  Input,
  Key,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Section,
} from "react-aria-components";
import {
  hid_usage_from_page_and_id,
  hid_usage_page_get_ids,
} from "../hid-usages";
import { useCallback, useId, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import { VirtualKeyboard } from "./VirtualKeyboard";
import {
  HidUsagePage,
  isUsageAllowed,
  withImplicitModifiers,
} from "./virtualKeys";

export type { HidUsagePage } from "./virtualKeys";

export interface HidUsagePickerProps {
  label?: string;
  value?: number;
  usagePages: HidUsagePage[];
  onValueChanged: (value?: number) => void;
  showVirtualKeyboard?: boolean;
}

type UsageSectionProps = HidUsagePage;

const UsageSection = ({ id, min, max }: UsageSectionProps) => {
  const info = useMemo(() => hid_usage_page_get_ids(id), [id]);

  const usages = useMemo(() => {
    let usages = info?.UsageIds || [];
    usages = usages.filter((usage) =>
      isUsageAllowed(hid_usage_from_page_and_id(id, usage.Id), [
        { id, min, max },
      ]),
    );

    return usages;
  }, [id, min, max, info]);

  return (
    <Section id={id}>
      <Header className="text-base-content/50">{info?.Name}</Header>
      <Collection items={usages}>
        {(i) => (
          <ListBoxItem
            className="rac-hover:bg-base-300 pl-3 relative rac-focus:bg-base-300 cursor-default select-none rac-selected:before:content-['✔'] before:absolute before:left-[0] before:top-[0]"
            id={hid_usage_from_page_and_id(id, i.Id)}
          >
            {i.Name}
          </ListBoxItem>
        )}
      </Collection>
    </Section>
  );
};

enum Mods {
  LeftControl = 0x01,
  LeftShift = 0x02,
  LeftAlt = 0x04,
  LeftGUI = 0x08,
  RightControl = 0x10,
  RightShift = 0x20,
  RightAlt = 0x40,
  RightGUI = 0x80,
}

const mod_labels: Record<Mods, string> = {
  [Mods.LeftControl]: "L Ctrl",
  [Mods.LeftShift]: "L Shift",
  [Mods.LeftAlt]: "L Alt",
  [Mods.LeftGUI]: "L GUI",
  [Mods.RightControl]: "R Ctrl",
  [Mods.RightShift]: "R Shift",
  [Mods.RightAlt]: "R Alt",
  [Mods.RightGUI]: "R GUI",
};

const all_mods = [
  Mods.LeftControl,
  Mods.LeftShift,
  Mods.LeftAlt,
  Mods.LeftGUI,
  Mods.RightControl,
  Mods.RightShift,
  Mods.RightAlt,
  Mods.RightGUI,
];

function mods_to_flags(mods: Mods[]): number {
  return mods.reduce((a, v) => a + v, 0);
}

function mask_mods(value: number) {
  return value & 0x00ffffff;
}

export const HidUsagePicker = ({
  label,
  value,
  usagePages,
  onValueChanged,
  showVirtualKeyboard = true,
}: HidUsagePickerProps) => {
  const labelId = useId();
  const mods = useMemo(() => {
    const flags = value ? value >> 24 : 0;

    return all_mods.filter((m) => m & flags).map((m) => m.toLocaleString());
  }, [value]);

  const selectionChanged = useCallback(
    (e: Key | null) => {
      let value = typeof e == "number" ? e : undefined;
      if (value !== undefined) {
        const mod_flags = mods_to_flags(mods.map((m) => parseInt(m)));
        value = withImplicitModifiers(value, mod_flags);
      }

      onValueChanged(value);
    },
    [onValueChanged, mods],
  );

  const modifiersChanged = useCallback(
    (m: string[]) => {
      if (!value) {
        return;
      }

      const mod_flags = mods_to_flags(m.map((m) => parseInt(m)));
      const new_value = withImplicitModifiers(value, mod_flags);
      onValueChanged(new_value);
    },
    [value, onValueChanged],
  );

  return (
    <div className="flex flex-col gap-2 min-w-0">
      {showVirtualKeyboard && (
        <VirtualKeyboard
          value={value}
          usagePages={usagePages}
          onValueChanged={selectionChanged}
        />
      )}
      <div className="flex flex-wrap gap-2 items-center relative">
        {label && <Label id={labelId}>{label}:</Label>}
        <ComboBox
          selectedKey={value ? mask_mods(value) : null}
          onSelectionChange={selectionChanged}
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : "Key code"}
        >
          <div className="flex">
            <Input className="p-1 rounded-l" />
            <Button className="rounded-r bg-primary text-primary-content w-8 h-8 flex justify-center items-center">
              <ChevronDown className="size-4" />
            </Button>
          </div>
          <Popover className="w-[var(--trigger-width)] max-h-4 shadow-md text-base-content rounded border-base-content bg-base-100">
            <ListBox
              items={usagePages}
              className="block max-h-[30vh] min-h-[unset] overflow-auto p-2"
              selectionMode="single"
            >
              {({ id, min, max }) => (
                <UsageSection id={id} min={min} max={max} />
              )}
            </ListBox>
          </Popover>
        </ComboBox>
        <CheckboxGroup
          aria-label="Implicit Modifiers"
          className="grid grid-flow-col gap-x-px auto-cols-[minmax(min-content,1fr)] content-stretch divide-x rounded-md"
          value={mods}
          onChange={modifiersChanged}
          isDisabled={value === undefined || value === 0}
        >
          {all_mods.map((m) => (
            <Checkbox
              key={m}
              value={m.toLocaleString()}
              className="text-nowrap cursor-pointer grid px-2 content-center justify-center rac-selected:bg-primary border-base-100 bg-base-300 hover:bg-base-100 first:rounded-s-md last:rounded-e-md rac-selected:text-primary-content"
            >
              {mod_labels[m]}
            </Checkbox>
          ))}
        </CheckboxGroup>
      </div>
    </div>
  );
};
