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
import { RuntimeContext } from "../runtime/context";
import {
  applyStudioBackup,
  createStudioBackup,
  planStudioRestore,
  studioBackupJSON,
} from "../runtime/backup";
import {
  BehaviorMap,
  errorMessage,
  KeymapBackup,
  KeymapRpc,
  parseKeymapBackup,
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
  const runtime = useContext(RuntimeContext);
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
    !busy &&
    !runtime.busy &&
    !runtime.error;

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
      if (!runtime.client)
        throw new Error(
          "Wait for runtime capability discovery before exporting.",
        );
      const data = await runtime.run(async () =>
        createStudioBackup(
          await readKeymap(),
          layout,
          behaviors,
          deviceName,
          await runtime.client!.snapshot(),
        ),
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(studioBackupJSON(data), null, 2) + "\n"], {
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
      setStatus(
        "Full backup exported: keymap, runtime combos/macros, settings and named references, including pending edits.",
      );
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
      planStudioRestore(
        parsed,
        keymap,
        layout,
        behaviors,
        runtime.client ? await runtime.client.snapshot() : {},
      );
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
          const result = await runtime.run(async () =>
            applyStudioBackup(
              backup,
              await readKeymap(),
              layout,
              behaviors,
              rpc,
              runtime.client,
            ),
          );
          onKeymapChanged(result.keymap);
          await runtime.reload();
          setStatus(
            "Keymap imported. Review it, then Save to keep it on the keyboard.",
          );
          return async () => {
            setBusy(true);
            try {
              await runtime.run(result.undo);
              await refresh();
              await runtime.reload();
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
        Export Full Backup JSON
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
        Import Backup JSON
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
          Version 2 restores layer names/bindings, runtime combos, named macros
          and global runtime timing. Version 1 remains keymap-only (raw runtime
          macro references are rejected). Export first. Capacity, behaviors,
          references and physical geometry are checked before any write.
          Target-only macros must be explicitly removed first. Writes are not
          transactional; interrupted restore uses a best-effort rollback
          journal. Empty combo slots may become disabled tombstones (source
          status can differ). No Save is requested during restore.
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
            Restore Backup in Memory
          </Button>
        </div>
      </dialog>
    </div>
  );
}
