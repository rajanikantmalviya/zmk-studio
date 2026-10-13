import { createContext, useMemo, useRef, useState } from "react";

export type UndoCallback = () => Promise<void>;

export type DoCallback = () => Promise<UndoCallback>;

export function useUndoRedo(): [
  (dc: DoCallback) => Promise<void>,
  () => Promise<void>,
  () => Promise<void>,
  boolean,
  boolean,
  () => void
] {
  const [locked, setLocked] = useState<boolean>(false);
  const operationInProgress = useRef(false);
  const [undoStack, setUndoStack] = useState<Array<[DoCallback, UndoCallback]>>(
    []
  );
  const [redoStack, setRedoStack] = useState<Array<DoCallback>>([]);

  const canUndo = useMemo(
    () => !locked && undoStack.length > 0,
    [locked, undoStack]
  );
  const canRedo = useMemo(
    () => !locked && redoStack.length > 0,
    [locked, redoStack]
  );

  const doIt = async (doCb: DoCallback, preserveRedo?: boolean) => {
    if (operationInProgress.current) {
      throw new Error("operation invoked when existing operation in progress");
    }
    operationInProgress.current = true;
    setLocked(true);
    try {
      const undo = await doCb();
      setUndoStack([[doCb, undo], ...undoStack]);
      if (!preserveRedo) {
        setRedoStack([]);
      }
    } finally {
      operationInProgress.current = false;
      setLocked(false);
    }
  };

  const undo = async () => {
    if (operationInProgress.current) {
      throw new Error("undo invoked when existing operation in progress");
    }

    if (undoStack.length === 0) {
      throw new Error("undo invoked with no operations to undo");
    }

    operationInProgress.current = true;
    setLocked(true);
    const [doCb, undoCb] = undoStack[0];
    try {
      await undoCb();
      setUndoStack(undoStack.slice(1));
      setRedoStack([doCb, ...redoStack]);
    } finally {
      operationInProgress.current = false;
      setLocked(false);
    }
  };

  const redo = async () => {
    if (operationInProgress.current) {
      throw new Error("redo invoked when existing operation in progress");
    }

    if (redoStack.length === 0) {
      throw new Error("redo invoked with no operations to redo");
    }

    const doCb = redoStack[0];

    await doIt(doCb, true);
    setRedoStack(redoStack.slice(1));
  };

  const reset = () => {
    setRedoStack([]);
    setUndoStack([]);
  };

  return [doIt, undo, redo, canUndo, canRedo, reset];
}

export const UndoRedoContext = createContext<
  ((dc: DoCallback) => Promise<void>) | null
>(null);
