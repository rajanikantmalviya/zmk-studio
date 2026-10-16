import {
  MetaError,
  NoResponseError,
  RpcConnection,
} from "@zmkfirmware/zmk-studio-ts-client";
import { ErrorConditions } from "@zmkfirmware/zmk-studio-ts-client/meta";
import { call_rpc } from "../rpc/logging";
import * as combo from "./generated/combo";
import * as macro from "./generated/macro";

export { combo, macro };
export const COMBO_IDENTIFIER = "cormoran__runtime_combo";
export const MACRO_IDENTIFIER = "cormoran__runtime_macro";

export interface RuntimeSnapshot {
  combos?: { settings: combo.GlobalSettings; definitions: combo.Combo[] };
  macros?: {
    settings: macro.MacroGlobalSettings;
    maxBytes: number;
    maxNameLength: number;
    summaries: macro.MacroSummary[];
    definitions: macro.MacroDetail[];
  };
}

export class RuntimeClient {
  persistentEpoch = 0;
  constructor(
    readonly connection: RpcConnection,
    readonly comboIndex?: number,
    readonly macroIndex?: number,
    readonly guard: () => void = () => {},
  ) {}

  static async discover(
    connection: RpcConnection,
    guard: () => void = () => {},
  ) {
    guard();
    try {
      const response = await call_rpc(connection, {
        custom: { listCustomSubsystems: {} },
      });
      guard();
      const subsystems = response.custom?.listCustomSubsystems?.subsystems;
      if (!subsystems)
        throw new Error("Missing custom subsystem discovery response.");
      return new RuntimeClient(
        connection,
        subsystems.find((s) => s.identifier === COMBO_IDENTIFIER)?.index,
        subsystems.find((s) => s.identifier === MACRO_IDENTIFIER)?.index,
        guard,
      );
    } catch (error) {
      // Old Studio firmware answers an unknown subsystem with no_response.
      if (
        error instanceof NoResponseError ||
        (error instanceof MetaError &&
          error.condition === ErrorConditions.RPC_NOT_FOUND)
      )
        return new RuntimeClient(connection, undefined, undefined, guard);
      throw error;
    }
  }

  private async payload(index: number | undefined, payload: Uint8Array) {
    this.guard();
    if (index === undefined)
      throw new Error("This firmware does not support this runtime editor.");
    const response = await call_rpc(this.connection, {
      custom: { call: { subsystemIndex: index, payload } },
    });
    this.guard();
    if (!response.custom?.call || response.custom.call.subsystemIndex !== index)
      throw new Error("Missing or mismatched custom RPC response.");
    return response.custom.call.payload;
  }

  async combo(request: combo.Request): Promise<combo.Response> {
    if (
      request.save ||
      request.discard ||
      request.resetCombo ||
      Object.values(request).some(
        (value) => value && "persist" in value && value.persist,
      )
    )
      this.persistentEpoch++;
    const response = combo.Response.decode(
      await this.payload(
        this.comboIndex,
        combo.Request.encode(request).finish(),
      ),
    );
    if (response.error) throw new Error(response.error.message);
    const expected = request.listCombos
      ? response.listCombos
      : request.getCombo
        ? response.getCombo
        : request.getGlobalSettings
          ? response.getGlobalSettings
          : response.status;
    if (!expected) throw new Error("Missing expected runtime combo response.");
    return response;
  }

  async macro(request: macro.Request): Promise<macro.Response> {
    if (
      request.saveMacros ||
      request.discardMacros ||
      request.deleteMacro ||
      Object.values(request).some(
        (value) => value && "persist" in value && value.persist,
      )
    )
      this.persistentEpoch++;
    const response = macro.Response.decode(
      await this.payload(
        this.macroIndex,
        macro.Request.encode(request).finish(),
      ),
    );
    if (response.error) throw new Error(response.error.message);
    const expected = request.listMacros
      ? response.listMacros
      : request.getMacro
        ? response.getMacro
        : request.getMacroGlobalSettings
          ? response.getMacroGlobalSettings
          : response.status;
    if (!expected) throw new Error("Missing expected runtime macro response.");
    return response;
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const snapshot: RuntimeSnapshot = {};
    if (this.comboIndex !== undefined) {
      const settings = (await this.combo({ getGlobalSettings: {} }))
        .getGlobalSettings?.settings;
      const definitions = (await this.combo({ listCombos: {} })).listCombos
        ?.combos;
      if (!settings || !definitions)
        throw new Error("Incomplete runtime combo discovery.");
      if (!settings.maxCombo || !settings.timeoutMs)
        throw new Error(
          "Incompatible runtime combo schema: missing slot capacity or global timing.",
        );
      if (
        settings.maxCombo > 16 ||
        new Set(definitions.map((item) => item.index)).size !==
          definitions.length ||
        definitions.some((item) => item.index >= settings.maxCombo)
      )
        throw new Error(
          "Runtime combo slot discovery exceeds or conflicts with the pinned 16-slot wire schema.",
        );
      // list_combos omits never-created slots and holes without DT defaults.
      // These are capacity-derived vacant slots, not fabricated RPC replies.
      for (let index = 0; index < settings.maxCombo; index++)
        if (!definitions.some((item) => item.index === index))
          definitions.push(
            combo.Combo.create({
              index,
              source: combo.ComboSource.COMBO_SOURCE_EMPTY,
            }),
          );
      definitions.sort((a, b) => a.index - b.index);
      snapshot.combos = { settings, definitions };
    }
    if (this.macroIndex !== undefined) {
      const settings = (await this.macro({ getMacroGlobalSettings: {} }))
        .getMacroGlobalSettings?.settings;
      const list = (await this.macro({ listMacros: {} })).listMacros;
      if (!settings || !list)
        throw new Error("Incomplete runtime macro discovery.");
      if (
        !settings.maxEntries ||
        !settings.poolBytesTotal ||
        !list.maxMacroBytes ||
        !list.maxNameLength
      )
        throw new Error(
          "Incompatible runtime macro schema: missing slot, body, name or shared RAM capacities.",
        );
      if (settings.maxEntries > 16 || list.maxNameLength > 31)
        throw new Error(
          "Runtime macro capacities exceed the pinned 16-slot/32-byte-name wire schema.",
        );
      if (
        new Set(list.macros.map((item) => item.slot)).size !==
          list.macros.length ||
        new Set(list.macros.map((item) => item.name)).size !==
          list.macros.length ||
        list.macros.some((item) => item.slot >= settings.maxEntries)
      )
        throw new Error(
          "Runtime macro discovery returned conflicting slot identities.",
        );
      const definitions: macro.MacroDetail[] = [];
      for (const summary of list.macros) {
        const detail = (await this.macro({ getMacro: { slot: summary.slot } }))
          .getMacro?.macro;
        if (
          !detail ||
          detail.name !== summary.name ||
          detail.slot !== summary.slot
        )
          throw new Error("Macro identity changed while reading. Retry.");
        definitions.push(detail);
      }
      snapshot.macros = {
        settings,
        maxBytes: list.maxMacroBytes,
        maxNameLength: list.maxNameLength,
        summaries: list.macros,
        definitions,
      };
    }
    return snapshot;
  }

  async putCombo(definition: combo.Combo) {
    const { name, index, ...fields } = definition;
    if (!fields.keyPositions.length && !fields.enabled) {
      await this.combo({ deleteCombo: { index, persist: false } });
    } else {
      await this.combo({ setCombo: { ...fields, index, persist: false } });
    }
    await this.combo({ setComboName: { index, name, persist: false } });
  }

  async putMacro(definition: macro.MacroDetail) {
    const existing = (await this.snapshot()).macros?.definitions.find(
      (m) => m.name === definition.name,
    );
    if (!existing || existing.slot !== definition.slot)
      throw new Error("Macro slot identity changed. Reload before editing.");
    // Clear first, then grow monotonically to avoid transient pool exhaustion
    // when replacing a large old body with a differently shaped smaller one.
    await this.macro({
      setMacroStepCount: { slot: existing.slot, stepCount: 0, persist: false },
    });
    for (const step of definition.steps) {
      const identity = (await this.macro({ getMacro: { slot: existing.slot } }))
        .getMacro?.macro;
      if (!identity || identity.name !== definition.name)
        throw new Error(
          "Macro slot was reused during editing. Stop and inspect references.",
        );
      await this.macro({
        appendMacroStep: { slot: existing.slot, step, persist: false },
      });
    }
  }

  async save() {
    if (this.macroIndex !== undefined) await this.macro({ saveMacros: {} });
    if (this.comboIndex !== undefined) await this.combo({ save: {} });
  }
  async discard() {
    if (this.comboIndex !== undefined) await this.combo({ discard: {} });
    if (this.macroIndex !== undefined) await this.macro({ discardMacros: {} });
  }

  async saveKeymap() {
    await this.save();
    this.guard();
    const response = await call_rpc(this.connection, {
      keymap: { saveChanges: true },
    });
    this.guard();
    if (!response.keymap?.saveChanges || response.keymap.saveChanges.err)
      throw new Error(
        "Keymap save failed. Runtime definitions may already be saved; inspect all subsystems.",
      );
  }

  async discardKeymap() {
    this.guard();
    const response = await call_rpc(this.connection, {
      keymap: { discardChanges: true },
    });
    this.guard();
    if (!response.keymap?.discardChanges)
      throw new Error(
        "Keymap discard failed. Runtime definitions were not discarded.",
      );
    // Remove unsaved keymap/combo references before dropping newly created macros.
    await this.discard();
  }
}
