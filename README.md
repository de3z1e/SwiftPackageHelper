# VSXcode

Lightweight Xcode project integration for VS Code — IntelliSense, build tasks, full debugging with breakpoints and console output on simulators, physical devices, and your Mac, and native swift-format code formatting. Single dependency: the [Swift extension](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode). Automatically generates `Package.swift` for full SourceKit-LSP support and configures build tasks that let you build, run, and debug iOS and macOS apps directly from VS Code.

### How It Works

Open a folder containing an `.xcodeproj` and the extension handles the rest:

1. **Auto-generates `Package.swift`** from the Xcode project on activation, with correct target paths, resources, dependencies, and Swift settings.
2. **Auto-configures build tasks** with sensible defaults (target, scheme, device/simulator). Bundle id is sourced live from `project.pbxproj` on every operation, so renames take effect immediately.
3. **Configures SourceKit-LSP** for the active run destination so IntelliSense resolves the right SDK — the iOS simulator SDK for UIKit, or the macOS SDK when targeting My Mac.
4. **Silently regenerates** `Package.swift` whenever the `.pbxproj` file changes.
5. **Syncs project files to the Xcode project** — when `.swift` files or `.xcdatamodeld` model bundles are added or removed in a target directory, the `.xcodeproj` is updated automatically (build file, file reference, group, and Sources-phase entries — plus the XCVersionGroup for model bundles).
6. **Resolves Core Data codegen in IntelliSense** — models using class/category codegen get their `NSManagedObject` subclasses generated with the same tool Xcode's build uses and fed to SourceKit-LSP, so generated types resolve without touching your model, project file, or repository — and regenerate automatically when you edit entities.

### Sidebar

The extension adds a panel to the Activity Bar with configurable build settings:

- **Project** — select which `.xcodeproj` to use (when multiple exist)
- **Target** — select the build target
- **Scheme** — select the build scheme
- **Bundle ID** — read directly from `project.pbxproj`; click to edit (writes `PRODUCT_BUNDLE_IDENTIFIER` back to pbxproj). The row shows the id a build actually produces, followed by the **Dev: On/Off** state, and carries an inline toggle button on the right (hover the row) — `○` turns dev mode on, `✓` turns it off. Also shows a ⚠ warning when an app with the same product name but a different bundle id is installed on the selected simulator — usually a leftover from a previous rename. Use the row's trash action to uninstall the orphan.
- **Device** — select **My Mac**, a connected physical device (USB or Wi-Fi), or an available iOS simulator (My Mac appears only for macOS-capable targets)

**Dev Bundle ID** appends `-dev` to the bundle id at build time (`com.example.MyApp` → `com.example.MyApp-dev`), so development builds install alongside the App Store build instead of replacing it. It's an `xcodebuild` setting override (`PRODUCT_BUNDLE_IDENTIFIER=$(inherited)-dev`) — `project.pbxproj` is never modified, so the shipping bundle id stays exactly as committed, and the suffix follows any later rename automatically. The dev and production apps are treated as an expected pair, never flagged as orphans of each other.

> **Note:** the suffix applies to every target the scheme builds. Projects with embedded app extensions (whose bundle ids must stay prefixed by the host app's) will be warned once, as those targets may fail to build or install. On physical devices the new id needs provisioning — automatic signing handles it via `-allowProvisioningUpdates`; manual profiles must cover the `-dev` id.

Title bar actions: **Build**, **Build & Run**, **Refresh**, **Sync Files**, and **Clean DerivedData** (deletes the current scheme's build cache — or all schemes — along with the workspace's Core Data codegen when present, reports the disk space reclaimed, and regenerates the codegen immediately).

### Commands

| Command | Description |
|---------|-------------|
| **Swift: Generate Package.swift from Xcode Project** | Generates `Package.swift` using the Debug configuration with a diff view. |
| **Swift: Generate Package.swift from Xcode Project (with Options)** | Same as above but lets you choose Debug or Release configuration. |
| **Swift: Configure Build Tasks** | Manually configure build target, scheme, and device/simulator (bundle id is read from pbxproj). |

### Package.swift Generation

- Detects the first `.xcodeproj` in the workspace (or lets you pick when multiple exist).
- Extracts Swift tools version, platform deployment targets, targets, and product metadata.
- Resolves target source paths on disk, including `productName` directory lookup.
- Resolves resource file paths on disk relative to the target directory.
- Includes per-target swift settings (`.define`, `.unsafeFlags`, `.swiftLanguageMode`), linked system frameworks, resources, header search paths, target dependencies, and excluded files.
- Runs Core Data class generation (momc) for targets with `.xcdatamodeld` models and wires the generated sources into the manifest, so codegen types resolve in IntelliSense.
- Automatically configures SourceKit-LSP server arguments for the selected destination — the iOS simulator SDK (SDK path, target triple, framework search path), or the host macOS SDK when targeting My Mac.
- Shows a diff view before overwriting when run manually from the command palette.

### Build Tasks

Build tasks are integrated directly into the extension — no shell scripts, `tasks.json`, or `launch.json` files are written to the workspace.

- Uses VS Code's `TaskProvider` API to provide build, build-install, and run-and-debug tasks.
- Full debug support with breakpoints and `print()` console output for **simulator**, **physical device**, and **macOS** builds. Simulator and device output streams into the task terminal (the same panel as the build output), with each line prefixed by a wall-clock timestamp; the Debug Console shows only LLDB messages on those runs.
- Simulator debugging uses `simctl launch --console-pty --wait-for-debugger` with LLDB DAP attach.
- Physical device debugging uses `devicectl --console --start-stopped` with LLDB DAP remote-ios attach. Supports USB and Wi-Fi connected devices (requires Xcode 15+). Code signing uses the project's existing settings from Xcode.
- macOS debugging launches the built `.app` directly under LLDB DAP (`request: launch`) — no simulator boot or install step; the app's output streams to the Debug Console.
- Build configuration is stored in VS Code's workspace state (persists across sessions).
- Build output is colorized: errors in red, warnings in yellow.
- Build products are isolated per scheme under `~/Library/Developer/VSCode/DerivedData/`. The **Clean DerivedData** title-bar action deletes the current scheme's tree (or all schemes) along with the workspace's Core Data codegen when present, after confirmation; it reports the reclaimed disk space and regenerates the codegen immediately.
- After a successful macOS build, the `.app` wrapper's mod date is bumped so the Dock/Finder icon cache picks up app-icon changes — incremental builds rewrite the bundle's contents without touching the wrapper, which otherwise leaves a stale icon on long-lived build trees.

### Code Format (swift-format)

A dedicated Code Format panel in the sidebar provides native [swift-format](https://github.com/apple/swift-format) integration — the formatter bundled with Xcode. No extra tools to install.

- **Format on Save** — automatically formats Swift files when saving using `swift-format format`.
- **Lint Mode** — shows swift-format violations as diagnostics in the Problems panel using `swift-format lint`.
- **18 formatting options** — indentation, line length, line breaks, trailing commas, and more. All configurable from the sidebar with true/false dropdowns and number inputs.
- **43 rules** organized into Format Rules (21 auto-fix rules) and Lint Rules (22 report-only rules). Each rule has a toggle, description, default state, and reset button.
- **Per-section controls** — enable/disable all rules in a section with a single toggle. Partial state indicator when some rules are enabled.
- **Global / Local profiles** — Global profile shares formatting options and rules across all projects. Local profile keeps settings per-project. Switch between them with an option to save local changes to global.
- **Config file sync** — settings auto-generate `.vscode/.swift-format`. Manual edits to the config file are synced back to the UI.

### Testing

XCTest integration via the VS Code Testing sidebar — tests are discovered from the Xcode project and run with `xcodebuild`.

- **Run, Debug, and Coverage** profiles in the Testing sidebar, powered by `xcodebuild test`.
- **Test debugging with breakpoints** — the Debug profile builds for testing, attaches LLDB DAP with `--waitfor`, then runs `test-without-building` so the debugger catches the test host at launch.
- **Code coverage** — the Coverage profile enables `xcodebuild -enableCodeCoverage`, then parses the xcresult via `xcrun xccov` to show per-file percentages and per-line green/red gutter annotations.
- **Test results** in the Testing sidebar with pass/fail status, durations, and assertion failure messages with source locations.

### Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| ⌘R | — | Build, install, and launch with debugger attached |
| ⌘⇧B | Build tasks configured | Build (or build-for-testing when a test target is selected) |

### AI agent usage

Working with an AI coding assistant in a Swift project that uses VSXcode? Point your agent at [docs/AGENT_README.md](docs/AGENT_README.md) — it documents what the extension does automatically (so the agent doesn't duplicate the work) and how to invoke its build/run/debug/test capabilities (so the agent uses the wired-up tasks instead of constructing raw `xcodebuild` commands).

### Dependencies

- [Swift for VS Code](https://marketplace.visualstudio.com/items?itemName=swiftlang.swift-vscode) — automatically installed as a dependency. Provides SourceKit-LSP support and includes LLDB DAP for debugging.

### Installation

- Install from the VS Code Marketplace (search for `VSXcode`).
- Install the bundled package directly: `code --install-extension vsxcode-3.8.1.vsix`.
- VS Code UI alternative: **Extensions → … → Install from VSIX…** and pick the packaged file.

#### Build from source

```bash
npm install              # install dev dependencies
npm run package          # runs tsc build and produces vsxcode-<version>.vsix
code --install-extension vsxcode-3.8.1.vsix
```
