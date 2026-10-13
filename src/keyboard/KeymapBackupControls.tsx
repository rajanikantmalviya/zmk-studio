import { useContext, useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import type {
  Keymap,
  PhysicalLayout,
} from "@zmkfirmware/zmk-studio-ts-client/keymap";
import { ConnectionContext } from "../rpc/ConnectionContext";
import { LockStateContext } from "../rpc/LockStateContext";
import { call_rpc } from "../rpc/logging";
import { UndoRedoContext } from "../undoRedo";
import { useModalRef } from "../misc/useModalRef";
import {
  applyKeymapBackup,
  BehaviorMap,
  createKeymapBackup,
  errorMessage,
  KeymapBackup,
  KeymapRpc,
  parseKeymapBackup,
  validateKeymapBackup,
} from "./keymapBackup";

interface KeymapBackupControlsProps {
  keymap: Keymap;
  layout: PhysicalLayout;
  behaviors: BehaviorMap;
  deviceName: string;
  onKeymapChanged: (keymap: Keymap) => void;
}

export function KeymapBackupControls({
  keymap,
  layout,
  behaviors,
  deviceName,
  onKeymapChanged,
}: KeymapBackupControlsProps) {
  const connection = useContext(ConnectionContext);
  const lockState = useContext(LockStateContext);
  const undoRedo = useContext(UndoRedoContext);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<KeymapBackup>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const fileRead = useRef(0);
  const mounted = useRef(true);
  const active = useRef({ connection, lockState });
  active.current = { connection, lockState };
  const dialog = useModalRef(open || busy);
  const ready =
    !!connection.conn &&
    lockState === LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED &&
    Object.keys(behaviors).length > 0 &&
    !busy;

  useEffect(() => {
    fileRead.current++;
    setBackup(undefined);
    setOpen(false);
    setError(undefined);
    setStatus(undefined);
  }, [connection, lockState, layout]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rpc: KeymapRpc = async (request) => {
    if (
      !mounted.current ||
      !connection.conn ||
      active.current.connection !== connection ||
      active.current.lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      throw new Error(
        "The keyboard disconnected or locked. Reconnect and unlock it.",
      );
    }
    const response = await call_rpc(connection.conn, request);
    if (
      !mounted.current ||
      active.current.connection !== connection ||
      active.current.lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    ) {
      throw new Error(
        "The keyboard disconnected or locked during the operation.",
      );
    }
    return response;
  };

  const readKeymap = async () => {
    const response = await rpc({ keymap: { getKeymap: true } });
    if (!response.keymap?.getKeymap) {
      throw new Error("Could not read the keyboard's keymap.");
    }
    return response.keymap.getKeymap;
  };

  const refresh = async () => onKeymapChanged(await readKeymap());

  const exportKeymap = async () => {
    setError(undefined);
    setStatus(undefined);
    setBusy(true);
    try {
      const data = createKeymapBackup(
        await readKeymap(),
        layout,
        behaviors,
        deviceName,
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `${deviceName.replace(/[^a-zA-Z0-9_-]/g, "_") || "zmk"}-keymap.json`;
        document.body.appendChild(link);
        try {
          link.click();
        } finally {
          link.remove();
        }
      } finally {
        // Allow the webview/browser to start consuming the download.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      setStatus("Keymap exported, including pending edits.");
    } catch (cause) {
      console.error("Keymap export failed", cause);
      setError(errorMessage(cause));
      if (!mounted.current) window.alert(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const readFile = async (file: File) => {
    const sequence = ++fileRead.current;
    setBackup(undefined);
    setError(undefined);
    try {
      const parsed = parseKeymapBackup(await file.text());
      validateKeymapBackup(parsed, keymap, layout, behaviors);
      if (mounted.current && sequence === fileRead.current) {
        setBackup(parsed);
      }
    } catch (cause) {
      if (mounted.current && sequence === fileRead.current) {
        console.error("Invalid keymap backup", cause);
        setError(errorMessage(cause));
      }
    }
  };

  const applyImport = async () => {
    if (!backup || !undoRedo) return;
    setError(undefined);
    setStatus(undefined);
    try {
      await undoRedo(async () => {
        setBusy(true);
        try {
          const result = await applyKeymapBackup(
            backup,
            await readKeymap(),
            layout,
            behaviors,
            rpc,
          );
          onKeymapChanged(result.keymap);
          setStatus(
            "Keymap imported. Review it, then Save to keep it on the keyboard.",
          );
          return async () => {
            setBusy(true);
            try {
              await result.undo();
              await refresh();
              setStatus("Keymap import undone.");
            } catch (cause) {
              console.error("Could not undo keymap import", cause);
              setError(
                `${errorMessage(cause)} Reconnect and inspect the keymap before saving.`,
              );
              setOpen(true);
              throw cause;
            } finally {
              setBusy(false);
            }
          };
        } catch (cause) {
          console.error("Keymap import failed", cause);
          setError(errorMessage(cause));
          setOpen(true);
          try {
            await refresh();
          } catch (refreshError) {
            setError(
              `${errorMessage(cause)} Could not reload the keymap: ${errorMessage(refreshError)}`,
            );
          }
          throw cause;
        } finally {
          setBusy(false);
        }
      });
      setOpen(false);
      setBackup(undefined);
      setStatus(
        "Keymap imported. Review it, then Save to keep it on the keyboard.",
      );
    } catch (cause) {
      console.error("Keymap import operation failed", cause);
      setError((existing) => existing ?? errorMessage(cause));
      setOpen(true);
      if (!mounted.current) window.alert(errorMessage(cause));
    }
  };

  return (
    <div className="flex flex-col gap-2 max-w-64">
      <Button
        className="rounded bg-base-100 hover:bg-base-300 px-3 py-2 disabled:opacity-50"
        isDisabled={!ready}
        onPress={exportKeymap}
      >
        Export Keymap JSON
      </Button>
      <Button
        className="rounded bg-base-100 hover:bg-base-300 px-3 py-2 disabled:opacity-50"
        isDisabled={!ready || !undoRedo}
        onPress={() => {
          setBackup(undefined);
          setError(undefined);
          setStatus(undefined);
          setOpen(true);
        }}
      >
        Import Keymap JSON
      </Button>
      {!open && error && (
        <p role="alert" className="text-error text-sm">
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="text-sm">
          {status}
        </p>
      )}
      <dialog
        ref={dialog}
        aria-labelledby="keymap-import-title"
        aria-busy={busy}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        onClose={() => {
          if (!busy) {
            fileRead.current++;
            setOpen(false);
          }
        }}
        className="p-5 rounded-lg bg-base-100 text-base-content backdrop:bg-[rgba(0,0,0,0.5)] max-w-lg"
      >
        <h2 id="keymap-import-title" className="my-2 text-lg">
          Import / Export Keymap
        </h2>
        <p>
          Import replaces all layer names and key bindings, adding or removing
          layers as needed. Current pending edits will be replaced. Nothing is
          saved permanently until you click Save. Export first to keep a backup.
        </p>
        <label className="block my-3">
          Keymap JSON file
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            className="block my-2 max-w-full"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void readFile(file);
            }}
          />
        </label>
        {backup && (
          <p>
            Backup from {backup.deviceName}: {backup.layers.length} layers,
            physical layout "{backup.physicalLayout.name}".
          </p>
        )}
        {error && (
          <p role="alert" className="text-error my-2">
            {error}
          </p>
        )}
        {busy && <p role="status">Updating keymap. Please wait...</p>}
        <div className="flex justify-end my-2 gap-3">
          <Button
            className="rounded bg-base-200 hover:bg-base-300 px-3 py-2 disabled:opacity-50"
            isDisabled={busy}
            onPress={() => {
              fileRead.current++;
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            className="rounded bg-base-200 hover:bg-base-300 px-3 py-2 disabled:opacity-50"
            isDisabled={!backup || !ready || !undoRedo}
            onPress={applyImport}
          >
            Replace Keymap
          </Button>
        </div>
      </dialog>
    </div>
  );
}
