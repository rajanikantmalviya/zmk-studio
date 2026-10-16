import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { LockState } from "@zmkfirmware/zmk-studio-ts-client/core";
import { ConnectionState } from "../rpc/ConnectionContext";
import { useSub } from "../usePubSub";
import { RuntimeClient, RuntimeSnapshot } from "./client";

export interface RuntimeState {
  client?: RuntimeClient;
  snapshot: RuntimeSnapshot;
  error?: string;
  busy: boolean;
  reload: () => Promise<void>;
  run: <T>(action: () => Promise<T>) => Promise<T>;
}
export const RuntimeContext = createContext<RuntimeState>({
  snapshot: {},
  busy: false,
  reload: async () => {},
  run: async (action) => action(),
});

export function useRuntime(
  connection: ConnectionState,
  lockState: LockState,
): RuntimeState {
  const [client, setClient] = useState<RuntimeClient>();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const reloadPending = useRef<{
    session: ConnectionState;
    promise: Promise<void>;
  }>();
  const active = useRef({ connection, lockState });
  active.current = { connection, lockState };
  const reload = useCallback(async () => {
    if (!client) return;
    const session = active.current.connection;
    if (reloadPending.current?.session === session)
      return reloadPending.current.promise;
    const request = (async () => {
      setBusy(true);
      try {
        const data = await client.snapshot();
        client.guard();
        setSnapshot(data);
        setError(undefined);
      } catch (cause) {
        if (active.current.connection === session)
          setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      } finally {
        if (active.current.connection === session && !operation.current)
          setBusy(false);
      }
    })();
    reloadPending.current = { session, promise: request };
    try {
      await request;
    } finally {
      if (reloadPending.current?.promise === request)
        reloadPending.current = undefined;
    }
  }, [client]);
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    if (
      operation.current ||
      reloadPending.current?.session === active.current.connection
    )
      throw new Error(
        "Wait for the current Studio runtime operation to finish.",
      );
    client?.guard();
    operation.current = true;
    setBusy(true);
    try {
      return await action();
    } finally {
      operation.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    setClient(undefined);
    setSnapshot({});
    setError(undefined);
    setBusy(false);
    if (
      !connection.conn ||
      lockState !== LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
    )
      return;
    let cancelled = false;
    const guard = () => {
      if (
        cancelled ||
        active.current.connection !== connection ||
        active.current.lockState !==
          LockState.ZMK_STUDIO_CORE_LOCK_STATE_UNLOCKED
      )
        throw new Error(
          "Keyboard disconnected or locked. Reload and unlock before continuing.",
        );
    };
    setBusy(true);
    void (async () => {
      const discovered = await RuntimeClient.discover(connection.conn!, guard);
      const data = await discovered.snapshot();
      guard();
      setClient(discovered);
      setSnapshot(data);
    })()
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connection, lockState]);
  useSub("rpc_notification.custom.customNotification", () => {
    if (operation.current) return;
    void reload().catch((cause) =>
      console.error("Runtime notification refresh failed", cause),
    );
  });
  return { client, snapshot, busy, error, reload, run };
}
