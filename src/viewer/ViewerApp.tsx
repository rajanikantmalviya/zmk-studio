import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  bindingLabel,
  displayedKeys,
  effectiveBinding,
  parseConfiguration,
  parseSnapshot,
  ViewerConfiguration,
  ViewerSnapshot,
  viewerBounds,
  viewerOverlaySize,
  viewerShortcuts,
  viewerShortcutEdges,
  ViewerShortcuts,
} from "./model";

interface Port {
  id: string;
  label: string;
}
interface StateEvent {
  connectionId: number;
  state: unknown;
}
interface DisconnectedEvent {
  connectionId: number;
  error: string;
}

export function ViewerApp() {
  const [ports, setPorts] = useState<Port[]>([]);
  const [port, setPort] = useState("");
  const [config, setConfig] = useState<ViewerConfiguration>();
  const [snapshot, setSnapshot] = useState<ViewerSnapshot>();
  const [released, setReleased] = useState<Map<number, number>>(new Map());
  const [size, setSize] = useState(100);
  const [combos, setCombos] = useState(false);
  const [onTop, setOnTop] = useState(true);
  const [typing, setTyping] = useState(false);
  const [combosHeight, setCombosHeight] = useState(0);
  const combosPanel = useRef<HTMLElement>(null);
  const shortcuts = useRef<ViewerShortcuts>({ display: false, combos: false });
  const [pixelRatio, setPixelRatio] = useState(window.devicePixelRatio);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  const configuration = useRef<ViewerConfiguration>();
  const connectionId = useRef<number>();
  const pendingState = useRef<StateEvent>();
  const pendingDisconnect = useRef<DisconnectedEvent>();
  const mounted = useRef(false);
  const generation = useRef({ value: 0 });
  const windowChanges = useRef(Promise.resolve());

  const report = useCallback((cause: unknown) => {
    console.error("Keyboard viewer", cause);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const available = await invoke<Port[]>("serial_list_devices");
      if (mounted.current) {
        setPorts(available);
        setPort((previous) =>
          available.some((candidate) => candidate.id === previous)
            ? previous
            : available[0]?.id ?? "",
        );
      }
    } catch (cause) {
      if (mounted.current) report(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [report]);
  const applyShortcuts = useCallback(
    (next: ViewerSnapshot, current: ViewerConfiguration) => {
      const held = viewerShortcuts(current, next);
      const edges = viewerShortcutEdges(shortcuts.current, held);
      shortcuts.current = held;
      if (edges.display) invoke("viewer_toggle_display").catch(report);
      if (edges.combos) setCombos((previous) => !previous);
    },
    [report],
  );

  useEffect(() => {
    mounted.current = true;
    const lifetime = generation.current;
    let disposed = false;
    const resize = () => setPixelRatio(window.devicePixelRatio);
    window.addEventListener("resize", resize);
    const unlisteners: UnlistenFn[] = [];
    const start = async () => {
      for (const subscribe of [
        () =>
          listen("viewer-controls", () => {
            if (!disposed) setTyping(false);
          }),
        () =>
          listen("viewer-display", () => {
            if (!disposed && configuration.current) setTyping(true);
          }),
        () =>
          listen<string>("viewer-window-error", ({ payload }) => {
            if (!disposed) report(payload);
          }),
        () =>
          listen<StateEvent>("viewer-state", ({ payload }) => {
            if (disposed) return;
            if (!configuration.current || connectionId.current === undefined) {
              pendingState.current = payload;
              return;
            }
            if (payload.connectionId !== connectionId.current) return;
            try {
              const next = parseSnapshot(payload.state, configuration.current);
              applyShortcuts(next, configuration.current);
              setSnapshot(next);
              setReleased((previous) => {
                const updated = new Map(previous);
                for (const position of next.released)
                  updated.set(position, Date.now() + 250);
                for (const [position] of next.pressed) updated.delete(position);
                return updated;
              });
            } catch (cause) {
              connectionId.current = undefined;
              configuration.current = undefined;
              setConfig(undefined);
              setSnapshot(undefined);
              report(cause);
              invoke("viewer_disconnect").catch(report);
            }
          }),
        () =>
          listen<DisconnectedEvent>("viewer-disconnected", ({ payload }) => {
            if (disposed) return;
            if (connectionId.current === undefined) {
              pendingDisconnect.current = payload;
              return;
            }
            if (payload.connectionId !== connectionId.current) return;
            connectionId.current = undefined;
            configuration.current = undefined;
            setConfig(undefined);
            setSnapshot(undefined);
            setReleased(new Map());
            shortcuts.current = { display: false, combos: false };
            setTyping(false);
            report(payload.error);
          }),
      ]) {
        const unlisten = await subscribe();
        if (disposed) {
          unlisten();
          return;
        }
        unlisteners.push(unlisten);
      }
      await refresh();
    };
    start().catch((cause) => {
      if (!disposed) {
        report(cause);
        setBusy(false);
      }
    });
    const timer = setInterval(() => {
      setReleased((previous) => {
        const now = Date.now();
        if (![...previous.values()].some((expiry) => expiry <= now))
          return previous;
        return new Map([...previous].filter(([, expiry]) => expiry > now));
      });
    }, 100);
    return () => {
      disposed = true;
      mounted.current = false;
      lifetime.value++;
      clearInterval(timer);
      window.removeEventListener("resize", resize);
      for (const unlisten of unlisteners) unlisten();
      connectionId.current = undefined;
      invoke("viewer_disconnect").catch((cause) =>
        console.error("Could not close viewer connection", cause),
      );
    };
  }, [refresh, report, applyShortcuts]);

  const disconnect = async () => {
    setBusy(true);
    connectionId.current = undefined;
    configuration.current = undefined;
    setConfig(undefined);
    setSnapshot(undefined);
    setReleased(new Map());
    shortcuts.current = { display: false, combos: false };
    try {
      await invoke("viewer_disconnect");
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    const current = ++generation.current.value;
    setBusy(true);
    setError(undefined);
    try {
      const result = await invoke<{
        connectionId: number;
        frames: unknown[];
        initialState: unknown;
      }>("viewer_connect", { id: port });
      if (!mounted.current || generation.current.value !== current) return;
      if (pendingDisconnect.current?.connectionId === result.connectionId) {
        throw new Error(pendingDisconnect.current.error);
      }
      const next = parseConfiguration(result.frames);
      const initial =
        pendingState.current?.connectionId === result.connectionId
          ? pendingState.current.state
          : result.initialState;
      const initialSnapshot = parseSnapshot(initial, next);
      shortcuts.current = viewerShortcuts(next, initialSnapshot);
      configuration.current = next;
      connectionId.current = result.connectionId;
      setConfig(next);
      setSnapshot(initialSnapshot);
      pendingState.current = undefined;
      pendingDisconnect.current = undefined;
      setReleased(new Map());
      setTyping(true);
    } catch (cause) {
      await invoke("viewer_disconnect").catch((cleanup) =>
        console.error("Could not close failed viewer connection", cleanup),
      );
      if (mounted.current && generation.current.value === current) {
        connectionId.current = undefined;
        configuration.current = undefined;
        setConfig(undefined);
        setSnapshot(undefined);
        report(cause);
      }
    } finally {
      if (mounted.current && generation.current.value === current)
        setBusy(false);
    }
  };

  const bounds = config && viewerBounds(config);
  useEffect(() => {
    const panel = combosPanel.current;
    if (!combos || !panel) {
      setCombosHeight(0);
      return;
    }
    const measure = () =>
      setCombosHeight(Math.ceil(panel.getBoundingClientRect().height) + 8);
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, [combos, config, typing]);
  const overlaySize = config && viewerOverlaySize(config, size, combosHeight);
  const overlayWidth = overlaySize?.width ?? 0;
  const overlayHeight = overlaySize?.height ?? 0;
  const overlayActive = typing && !!config && !error;
  useEffect(() => {
    let disposed = false;
    windowChanges.current = windowChanges.current
      .then(async () => {
        if (disposed) return;
        await invoke("viewer_set_overlay", {
          enabled: overlayActive,
          width: overlayWidth,
          height: overlayHeight,
          pixelRatio,
          combosHeight,
        });
      })
      .catch((cause) => {
        if (!disposed) {
          setTyping(false);
          report(cause);
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    overlayActive,
    overlayWidth,
    overlayHeight,
    pixelRatio,
    combosHeight,
    report,
  ]);
  const keys = config && snapshot ? displayedKeys(config, snapshot) : [];
  const layer = config?.layers.find(
    (candidate) => candidate.id === snapshot?.layers[0],
  );
  return (
    <main className={`viewer${overlayActive ? " typing-overlay" : ""}`}>
      <header>
        <button
          className="viewer-drag"
          aria-label="Move viewer"
          title="Drag to move the viewer controls"
          onMouseDown={(event) => {
            if (event.button === 0)
              getCurrentWindow().startDragging().catch(report);
          }}
        >
          <strong>{config?.deviceName ?? "ZMK Keyboard Viewer"}</strong>
        </button>
        {config ? (
          <>
            <span>
              Layer: <b>{layer?.name || `Layer ${layer?.id ?? ""}`}</b>
            </span>
            <button disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <>
            <select
              aria-label="Viewer USB port"
              value={port}
              disabled={busy}
              onChange={(event) => setPort(event.target.value)}
            >
              <option value="">Select viewer USB port</option>
              {ports.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id} - {candidate.label}
                </option>
              ))}
            </select>
            <button disabled={busy} onClick={refresh}>
              Refresh
            </button>
            <button disabled={busy || !port} onClick={connect}>
              {busy ? "Connecting..." : "Connect"}
            </button>
          </>
        )}
        <div className="viewer-tools">
          {config && (
            <button
              disabled={busy}
              onClick={() => setTyping(true)}
              title="Show only the keyboard, without intercepting clicks or focus"
            >
              Typing overlay
            </button>
          )}
          <button
            aria-label="Decrease keyboard size"
            disabled={size <= 10}
            onClick={() => setSize((previous) => previous - 10)}
          >
            -
          </button>
          <span>{size}%</span>
          <button
            aria-label="Increase keyboard size"
            disabled={size >= 300}
            onClick={() => setSize((previous) => previous + 10)}
          >
            +
          </button>
          <button
            disabled={!config}
            aria-pressed={combos}
            onClick={() => setCombos((previous) => !previous)}
          >
            Combos
          </button>
          <label>
            <input
              type="checkbox"
              checked={onTop}
              onChange={async (event) => {
                const next = event.target.checked;
                try {
                  await getCurrentWindow().setAlwaysOnTop(next);
                  setOnTop(next);
                } catch (cause) {
                  report(cause);
                }
              }}
            />
            On top
          </label>
          <button
            aria-label="Close viewer"
            title="Hide viewer to tray (Space+Backspace to show)"
            onClick={() => getCurrentWindow().close().catch(report)}
          >
            X
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="viewer-error">
          {error}
        </p>
      )}
      {!config && (
        <p className="viewer-help">
          Connect the left half over USB using viewer-enabled firmware. Select
          its second serial interface (the viewer port, not the Studio RPC
          port). This display does not type, change bindings, or need Studio to
          stay open. Closing hides it to the tray; keyboard input continues
          normally. After connecting, only the keyboard is shown over your other
          apps. Right-click the ZMK tray icon and choose Show controls to
          resize, view combos, disconnect, or exit. Space+Backspace toggles the
          display; Tab+Return shows or hides combos while connected.
        </p>
      )}
      {config && bounds && (
        <div className="viewer-keyboard-scroll">
          <svg
            viewBox={bounds.join(" ")}
            style={{ width: `${(bounds[2] * 58 * size) / 100}px` }}
            aria-label={`${config.layoutName}, active layer ${layer?.name ?? ""}`}
            className="viewer-keyboard"
          >
            {keys.map((key) => (
              <g
                key={key.position}
                transform={`rotate(${key.r} ${key.rx} ${key.ry})`}
                className={
                  key.pressed
                    ? "key-down"
                    : released.has(key.position)
                      ? "key-released"
                      : ""
                }
              >
                <title>
                  {key.hold ? `Tap: ${key.tap}; Hold: ${key.hold}` : key.tap}
                </title>
                <rect
                  x={key.x + 0.035}
                  y={key.y + 0.035}
                  width={key.width - 0.07}
                  height={key.height - 0.07}
                  rx={0.09}
                />
                {key.hold && (
                  <text
                    className="key-hold"
                    x={key.x + key.width / 2}
                    y={key.y + key.height * 0.28}
                    fontSize={Math.min(
                      0.17,
                      (key.width * 0.9) / Math.max(key.hold.length * 0.6, 1),
                    )}
                  >
                    {key.hold}
                  </text>
                )}
                <text
                  className="key-tap"
                  x={key.x + key.width / 2}
                  y={key.y + key.height * (key.hold ? 0.67 : 0.55)}
                  fontSize={Math.min(
                    0.32,
                    (key.width * 0.85) / Math.max(key.tap.length * 0.6, 1),
                  )}
                >
                  {key.tap}
                </text>
              </g>
            ))}
          </svg>
        </div>
      )}
      {config && overlayActive && (
        <div className="viewer-layer-label">
          {layer?.name || `Layer ${layer?.id ?? ""}`}
        </div>
      )}
      {config && combos && (
        <section
          ref={combosPanel}
          className="viewer-combos"
          aria-label="Firmware combos"
        >
          <h2>Chords / combos ({config.combos.length})</h2>
          {!config.combos.length ? (
            <p>No combos are defined in this firmware.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Chord</th>
                  <th>Action</th>
                  <th>Layers</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                {config.combos.map((combo) => {
                  const sourceLayer = combo.layers[0] ?? config.defaultLayer;
                  const chord = combo.positions
                    .map(
                      (position) =>
                        bindingLabel(
                          config,
                          effectiveBinding(config, position, [
                            sourceLayer,
                            config.defaultLayer,
                          ]),
                        ).tap,
                    )
                    .join(" + ");
                  return (
                    <tr key={combo.name}>
                      <td
                        title={`${combo.name}; positions ${combo.positions.join(", ")}`}
                      >
                        {chord}
                      </td>
                      <td>{bindingLabel(config, combo.binding).tap}</td>
                      <td>
                        {combo.layers.length
                          ? combo.layers
                              .map(
                                (id) =>
                                  config.layers.find(
                                    (candidate) => candidate.id === id,
                                  )?.name || `Layer ${id}`,
                              )
                              .join(", ")
                          : "All"}
                      </td>
                      <td>{combo.timeoutMs} ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}
      {config && (
        <footer>
          Display only - green: held physical key; blue: released. Layers follow
          firmware.
          <span>
            Space+Backspace: show/hide display. Tab+Return: show/hide combos.
            Right-click the ZMK tray icon for controls or to exit.
          </span>
          <button
            disabled={busy}
            onClick={async () => {
              await disconnect();
              await connect();
            }}
          >
            Reload keymap
          </button>
        </footer>
      )}
    </main>
  );
}
