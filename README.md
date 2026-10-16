# ZMK Studio

Initial work on the ZMK Studio UI.

## Standalone Windows keyboard viewer

Build the display-only app with `npm run native:viewer`. Run
`src-tauri\target\release\zmk-keyboard-viewer.exe` directly; no Studio installer
or web server is needed. Windows requires the WebView2 Runtime.
The separate frontend contains no keymap editor or assignment palette.

The viewer has no title bar, frame, or window shadow. After connecting it
switches to a **transparent typing overlay**: only the keycaps and active-layer
label remain, centered above the taskbar on the controls window's monitor.
It stays on top, does not take focus, and passes mouse clicks through to the
app underneath. Firmware key highlights and layer changes continue while you
type in your editor or other apps.

Right-click the **ZMK icon in the Windows system tray** and choose **Show
controls** to resize the keyboard, inspect combos, reload bindings, or
disconnect. Drag the device-name button to move the controls to another
monitor. Choose **Typing overlay** to return to the keyboard-only display.
The controls' **X** button (or Alt+F4) hides the viewer to the tray without
disconnecting. Left-click the tray icon to reopen controls. Choose the tray's
**Exit viewer** to quit and release the serial port.
While connected, press **Space+Backspace** together to toggle the on-screen
display, **Tab+Return** together to show/hide combos, and **Esc+Delete**
together to show/hide macros, including in typing overlay mode.
Combo and macro lists are mutually exclusive. Opening either list makes the
window active and mouse-interactive so its scrollable list accepts scrolling.
Closing the list returns to the passive, click-through keyboard display and
restores the previous application's focus when Windows permits it.
These shortcuts use the physical positions of the base-layer
tap bindings, so layer-tap holds and focus in other apps do not interfere.
Each chord toggles once per press; release either key before repeating it.
They only observe firmware telemetry and do not suppress input to other apps.
Disconnects and errors restore the controls automatically.
Printable key bindings also show their **Shift value in the upper-right corner**
(for example, `1` shows `!` and `/` shows `?`), including the tap side of
hold-tap keys. These reference legends assume a US host layout; modifiers,
navigation keys, macros and Ctrl/Alt/GUI chords do not get a character legend.

The viewer requires matching **viewer-enabled firmware**. Choose **USB** or
**Bluetooth** in its connection controls. Bluetooth requires an already paired
and connected keyboard with the separate viewer GATT service.
Discovery lists the operating system's connected BLE devices and has a bounded
timeout; it does not require the keyboard to advertise its viewer service.
Older USB-only firmware cannot provide Bluetooth viewer data. If Windows cached an
older service list, refresh the Bluetooth pairing after preserving saved
settings. Pairing or service discovery failures are reported rather than
falling back to guessed Windows keystrokes.

For USB, the Chocofi config
adds a read-only `studio-viewer-usb` snippet on the USB-connected left half.
Select the keyboard's **second USB serial interface** in the viewer, not the
Studio RPC interface. Studio and the viewer can use their separate ports at
the same time; neither app is required for ordinary keyboard input.

On Windows, both interfaces may be named **USB Serial Device**. Their COM
numbers can change after flashing or reconnecting. In Device Manager, inspect
each port's **Details > Hardware Ids**: the current dual-interface Chocofi
firmware uses `MI_00` for Studio and `MI_03` for the viewer. Select the viewer
interface; selecting Studio will not return viewer configuration.

If an older viewer reports **I/O operation has been aborted (os error 995)**,
rebuild it with `npm run native:viewer` and reopen the executable. The viewer
must not clear an asynchronous Windows serial port after opening it, because
that cancels its pending read. This app-side fix does not require reflashing.

Keys show tap values (A, Space, etc.), with compact hold labels (Lshft, Nav,
etc.) above them. Physical highlights and active layers come from firmware,
not guessed Windows output. Transparent keys resolve through active layers;
held keys retain their originating-layer labels while the display follows
layer-tap holds, toggles, and one-shot layers. Very short taps are shown by
release flashes. The keyboard display cannot type or modify firmware.

Use **- / +** to resize, **Combos** to show firmware chord positions, actions,
layer scopes and timing, **Macros** to show exported macro names and steps,
and **On top** to toggle the always-on-top window. Runtime-macro bindings use
the current macro names. Firmware configuration revisions trigger an
automatic reload of exported keymap, combo and macro definitions; use
**Reload keymap** with firmware that does not publish revisions.
Combo scopes use ordered layer indices, not stable keymap layer IDs.
Compiled scopes may also include inactive indices; those bits are retained in
runtime edits and backups, and the viewer labels them explicitly.
No typed-text log is recorded.

Telemetry is host-requested over USB at up to 40 snapshots/second, using a
low-priority firmware worker with bounded buffering. Exiting the viewer stops
requests and releases its port. Firmware input is never delayed waiting for
telemetry; key scanning, debounce, hold-tap and combo settings are unchanged.
Hardware timing and power impact still require measurement after flashing.

Bluetooth uses a separate read-only GATT service
`00000010-0196-6107-c967-c5cfb1c2482a`, a command characteristic starting with
`00000011`, and a data notification characteristic starting with `00000012`
(the remaining UUID suffix is identical). Subscribe before sending `C` or
`S`; notifications contain MTU-sized fragments of the same newline-delimited
JSON protocol. `E` enables bounded event-driven state streaming rather than
continuous polling. After five seconds without a state frame, Viewer sends an
`E` heartbeat to check the session and resume streaming after a keyboard reboot.
A failed heartbeat or missing response reports a disconnect instead of leaving
a frozen display. Configuration responses have explicit frame/count/byte
limits. Disconnecting the viewer drops its subscription, not the shared
Bluetooth HID connection. Actual Bluetooth typing latency, battery usage and
split-link coexistence require device measurements.

Viewer model tests run with `node --test scripts/viewer.test.mjs`. Optional
browser UI tests run with `node --test scripts/viewer-ui.test.mjs` when
`ZMK_VIEWER_TEST_CDP` points to an isolated Chromium/Edge debugging endpoint
and `ZMK_VIEWER_TEST_URL` points to the viewer development page. Those tests
use synthetic native/firmware events and do not verify radio or device timing.

## Click-to-assign virtual keyboard

Select a position on your keyboard, then click a key in the **Virtual keyboard**
palette to assign it. **Keyboard**, **Numpad**, and **Media** categories include
letters, punctuation, function keys, navigation keys, modifiers, and common
media controls. Modifier toggles let you assign combinations such as Ctrl+C.
The searchable key-code dropdown remains available for less common usages.

The default palette selects a compatible Key Press behavior automatically;
selecting a palette key replaces the current behavior with that key press.
Use **Advanced** for layer actions, hold-tap behaviors, macros, and other
firmware-defined behaviors. HID parameters in Advanced also have a clickable
palette. Unsupported usages are disabled according to firmware metadata.
Changes remain pending until **Save** and use the existing **Undo / Redo**.

If the connected firmware provides **Home Row Layer Tap**, select it under
**Advanced**, choose the hold layer as parameter 1 and the tap key as parameter
2. Tap types the key; a deliberate hold activates the layer. Tap then quickly
press-and-hold the same key repeats its tap key using the host's repeat settings.
The matching Corne firmware uses a 300 ms tapping term, a 175 ms quick-tap
window (between press starts), and 175 ms of prior typing inactivity before a
layer hold is allowed. It is an additional behavior, not a change to existing
Layer-Tap assignments. Older firmware must be upgraded before Studio can list
it; no settings reset is needed.

## Studio runtime combos and macros

Connect and **unlock** the keyboard, then open **Runtime Combos / Macros** in
the layer sidebar. Editors are explicitly unavailable on firmware without the
custom subsystems. Discovery uses identifiers, never compile-specific subsystem
numbers: `cormoran__runtime_combo` and `cormoran__runtime_macro`. Missing required
slot/body/name/shared-RAM capability fields are treated as an incompatible schema,
not an empty successful response.
The pinned nanopb schema carries at most 16 combo and 16 macro slots, and macro
names must fit a 32-byte wire buffer; incompatible advertised capacities are
rejected. Never-created combo slots omitted by `list_combos` are displayed as
capacity-derived empty slots, rather than treating missing get replies as success.

Combos use a visual physical-key picker and the existing behavior/action picker.
Edit their name, enabled state, layer mask, timeout, prior-idle guard and
inherit/on/off slow release. Overlap warnings identify shared physical keys on
overlapping layers. Slots show empty/default/overridden/runtime source status.
Delete creates a disabled override; **Reset compiled default** erases a stored
override immediately and is explicitly confirmed as persistent.

Macros support create, rename, ordered press/release/tap/delay steps, move/remove
steps, compact text preservation, and a US-ASCII text shortcut. The key and combo
binding pickers expose macros by **name**, resolving to their current slots.
Deletion, rename and reset are conservatively blocked while keys, combos
(including disabled ones), or other macros reference the slot. Clear those
references explicitly first. Free slots with dangling references cannot be
silently reused. Persisted macro deletion is immediate; reset may remove a macro
with no compiled default. These lifecycle operations require confirmation and
clear history rather than promising a reversible flash transaction.

**Apply ... in memory** leaves edits in RAM. The main **Save / Discard** controls
cover both runtime subsystems and the keymap. Body/definition edits, combo disable,
global timing and full imports use **Undo / Redo**. Effective custom notifications
reload runtime definitions; stale open drafts are rejected instead of silently
overwriting newer definitions.
Save and Discard establish a new history boundary (also if either partially fails), so an
import's later Undo cannot erase a now-persisted macro while saved key bindings
still refer to its slot. Restore journals reject undo across persistence/discard
boundaries even when invoked outside the UI. Save persists macros before combo
and keymap references; Discard restores keymap and combos before removing unsaved
macros. After Discard, the UI reloads all subsystems even if one step fails.

The discovered limits include combo slots and macro slots, name/body bytes and
shared RAM usage. Additional limits are the agreed firmware profile: 2-4 physical
keys per combo, a 63-byte UTF-8 combo name (64-byte nanopb buffer including NUL),
16-bit combo timing, and 64 expanded macro playback actions. These additional
limits are not advertised by the current RPC schema. Other compile-time profiles
need matching limits; firmware rejections are surfaced rather than hidden.

The MIT-licensed custom-compatible TypeScript client is pinned and vendored at
`vendor\zmk-studio-ts-client`; schemas/codecs and provenance are under
`src\runtime`. Its typed custom protobuf envelope preserves binary payloads over
the existing Studio USB/BLE framing. No cast to the upstream 0.0.18 request type
or JSON tunnel is used. The vendor's small local transport patch releases stream
locks after failures and handles enum-zero generic RPC errors correctly.
For read-only custom discovery only, it also accepts legacy firmware's
zero-ID RPC_NOT_FOUND reply as an explicitly unsupported subsystem. Other
response-ID mismatches remain errors.
Native USB explicitly enables DTR and sends every byte even if the serial driver
accepts partial writes. Windows CDC's zero-byte idle reads do not disconnect
Studio; actual read errors still terminate the connection. Native USB/BLE reply fragments use a shared ordered push
stream, so overlapping notifications cannot contend for a stream writer or lose
bytes. Transport write/read failures are surfaced instead of ignored.

RPC assumptions match the pinned community module schemas. Discovery indices
are session-local. Macro step RPCs address numeric slots; lifecycle RPCs use
names. Upstream rename may reallocate a slot, although the paired local firmware
patch preserves it. The frontend does not rely on that patch to allow referenced
rename. `delete_macro` has no memory-only flag, and `reset_combo` has no persistence
flag. Patched firmware must preserve default macro slot identity across reboot,
avoid resurrecting deleted defaults, and reject unsafe referenced/active slot
deletion. Firmware-native pause-for-release/movement macros are not converted
into editable runtime steps.
The macro schema reports unsaved status but does not expose default origin;
the UI explicitly labels that origin as unadvertised instead of guessing it.

There is **no transaction or compare-and-swap token** in this RPC schema.
Save/Discard can partially complete across subsystems. Do not type/play macros
or operate a second editor while applying definitions or restoring a backup:
macro bodies are cleared and rebuilt through several acknowledged RPCs. On
failure, inspect the visible error and reload; a lost response can mean a write
was applied. Unit tests use simulated RPC responses, not a real keyboard.
Local Corne hardware validation on October 14, 2026 also covered macro
create/body/rename/delete and reference guards, ordered Discard, saved macro and
combo execution across reset, BLE list refresh, both list shortcuts/focus/scroll,
and Viewer recovery after reset. Original settings were restored and verified
again after reset; no temporary test definitions remain on that device.

## JSON full backups and bulk editing

Connect and unlock your keyboard, then use **Export Full Backup JSON** in the
layer sidebar. New exports use version **2**, retaining all layer names/bindings,
effective runtime combo/macro definitions, global runtime timing, physical layout
geometry, the behavior-name catalog and named macro/slot mapping (each macro
definition records its source name and slot). Pending edits are included.
This works in the browser and the Tauri desktop app.

Edit the JSON in a text editor for bulk updates. Each binding has a firmware
`behaviorId` and unsigned 32-bit `param1` / `param2` values. For example, the
keyboard HID usage for A is `458756` (`0x00070004`); JSON numbers use decimal
notation. Preserve the `format`, `version`, physical layout, and behavior
catalog. Layer IDs must remain unique; parameters referring to layers use
these IDs, not layer-array indices.

Unassigned positions reported as `behaviorId: 0` are preserved in the JSON,
without adding a fictitious behavior to the catalog. Leave these positions
unchanged when editing: firmware cannot write or restore them through the
Studio API. They are not the same as the firmware's **None** behavior.

Use **Import Backup JSON**, choose the file, review the summary, and click
**Restore Backup in Memory**. Import checks format, complete runtime definitions,
behavior/action parameters, physical geometry, layer/slot capacity, UTF-8 name
limits, encoded macro size, playback queue and total shared RAM before mutation.
Select the backup's physical layout first. Version 2 translates unambiguous
behavior names to device-local IDs and macro references to target slots by
macro name; raw source slots are never reused across devices.

Import replaces layer names, bindings, and layer count/order from the file.
Layer references are translated to the connected keyboard's layer IDs.
Runtime layer-bearing actions require existing target layers so their IDs can
be validated before writes; add appropriate layers first if needed. Target-only
macros must be explicitly removed before exact restore: import will not erase
their persisted records silently. Existing named macro slots are reused safely;
new names require genuinely free, unreferenced slots. Runtime combos and global
timing are replaced from the backup. Empty combo slots may become disabled
tombstones, so effective configuration is restored but source/provenance status
need not match the exporting device.

Version **1** backups remain compatible for keymap-only restores. A version 1
binding to a runtime macro is rejected because its numeric slot has no named
definition to verify. Native compiled behaviors/macros remain firmware-owned;
backups do not change devicetree behavior definitions or unrelated settings.
Review the result and click **Save** to persist it. **Undo** reverts a full import
as one operation; **Discard** returns all supported subsystems to saved state,
including discarding edits made before importing.

Import keeps an inverse-operation journal. Runtime inverses are registered before
sending a write to account for responses lost after mutation, and newly created
macro names are removed during rollback. The keymap importer reports its own
acknowledged-change rollback state. This is best-effort rollback, not atomicity;
errors identify incomplete rollback and advise reconnecting/inspection before
saving. Combo source status and flash provenance cannot always be rolled back.

## Windows keyboard overlay and learning sessions

In the **Windows desktop app**, connect and unlock the keyboard, then enable
**Windows output overlay** in the sidebar. An always-on-top, click-through
keyboard appears at the bottom center of the Studio window's monitor, above
the taskbar, with a transparent background, no outer frame or window shadow,
and individually visible keycaps.
It does not take focus or intercept keystrokes. Green indicates
Windows key-down state; blue briefly indicates a key release.

The overlay starts at **120%** size (20% larger). Use **Smaller (-10%)** or
**Bigger (+10%)** in the sidebar to resize it in 10-percentage-point steps,
including during a learning session. Sizes start at 10%; the overlay scales
uniformly to fit the monitor's work area and stays centered above the taskbar.
The size selection lasts for the current connection.

**Displayed layer (manual)** selects the keymap layer shown by the overlay
without changing the keyboard's active layer. The current Studio protocol does
not report live active layers, physical positions, or resolved tap/hold
decisions. Highlights match Windows output against bindings on the displayed
layer; duplicate bindings can highlight multiple positions. This is not exact
firmware telemetry. The monitor observes all physical Windows keyboards, not
just the connected ZMK keyboard, and ignores injected key events.

Choose **Find the prompted key** or **Practice the displayed layer**, optionally
enable target hints, and start a **10-prompt** session. Sessions show immediate
feedback, attempts, progress, and accuracy. Practice targets use observable Key
Press bindings from the manually selected layer; custom macros, hold-tap
decisions, and unsupported outputs are not graded. Changing the layer or keymap
ends the current session. Prompts are graded by emitted keys, so duplicate
bindings cannot be distinguished by physical position.

Use an empty scratch editor for practice: your key presses still reach the
focused application and shortcuts have their normal effects. Stop a session
with **Stop**, or disable the overlay to stop monitoring. Monitoring is opt-in
for each connection, ends when the keyboard disconnects/locks or Studio closes,
and keeps only current pressed/recently released key codes and in-memory
learning statistics. It does not build or save typed-text logs. The browser
version cannot provide a Windows-wide overlay or background input monitoring.
