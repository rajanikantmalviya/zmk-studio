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
display and **Tab+Return** together to show/hide combos, including in typing
overlay mode. These shortcuts use the physical positions of the base-layer
tap bindings, so layer-tap holds and focus in other apps do not interfere.
Each chord toggles once per press; release either key before repeating it.
They only observe firmware telemetry and do not suppress input to other apps.
Disconnects and errors restore the controls automatically.

The viewer requires matching **viewer-enabled firmware**. The Chocofi config
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
layer scopes and timing, and **On top** to toggle the always-on-top window.
After editing the keymap in Studio, use **Reload keymap** to read current
bindings. No typed-text log is recorded.

Telemetry is host-requested over USB at up to 40 snapshots/second, using a
low-priority firmware worker with bounded buffering. Exiting the viewer stops
requests and releases its port. Firmware input is never delayed waiting for
telemetry; key scanning, debounce, hold-tap and combo settings are unchanged.
Hardware timing and power impact still require measurement after flashing.

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

## JSON keymap backups and bulk editing

Connect and unlock your keyboard, then use **Export Keymap JSON** in the
layer sidebar to download a readable backup of all layer names and bindings,
including pending edits. This works in the browser and the Tauri desktop app.

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

Use **Import Keymap JSON**, choose the file, review the summary, and click
**Replace Keymap**. Import validates the format, firmware behaviors, parameters,
key counts, layer capacity, and layer name limits before making changes. Select
the backup's physical layout first. Backups are intended for the same keyboard
and compatible firmware, not arbitrary keyboards or firmware with changed
behavior IDs.

Import replaces layer names, bindings, and layer count/order from the file.
Layer references are translated to the connected keyboard's layer IDs.
It does not configure firmware-defined behaviors, macros, or other settings.
Review the result and click **Save** to persist it on the keyboard. **Undo**
reverts the import as one operation; **Discard** restores the last saved keymap
(including discarding edits made before importing).

If an import fails, Studio attempts to roll back acknowledged changes without
discarding earlier pending edits. If the connection is interrupted or rollback
fails, reconnect and inspect the keyboard before saving.

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
