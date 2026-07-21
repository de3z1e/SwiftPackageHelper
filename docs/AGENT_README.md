# VSXcode — Agent README

> **Audience check.** This file is for AI agents working **inside user Swift projects** where the VSXcode extension is installed. If you are developing the VSXcode extension itself (i.e. you are inside the VSXcode source repository), **ignore this file** and read `CLAUDE.md` instead — that has the codebase guidance you need.

You are working in a workspace where the **VSXcode** VS Code extension is installed (publisher `de3z1e`, extension ID `de3z1e.vsxcode`). This document tells you what the extension does automatically and how to use its capabilities instead of duplicating work via raw shell commands.

**This file is a manual reference.** The user will point you at it when they want you to leverage the extension. It is not a prompt-injection vector and the extension does not auto-load it.

---

## What the extension already does — do NOT duplicate

The extension activates on `workspaceContains:**/*.pbxproj` or `onDebug`. Once active in a workspace that contains an Xcode project, the following happen automatically. **If you find yourself about to do any of these manually, stop — the extension already handles it.**

### Package.swift generation
- **What**: A `Package.swift` file in the workspace root, generated from `<project>.xcodeproj/project.pbxproj`. The generated file contains a "Managed by VSXcode — changes will be overwritten" header.
- **Trigger**: First-time generation on activation, then re-generation whenever `project.pbxproj` changes (a `FileSystemWatcher` fires).
- **Don't manually edit `Package.swift`.** Edits will be silently overwritten on the next pbxproj change. If you need to change something Package.swift exposes (platform deployment targets, swift settings, dependencies), modify the `.xcodeproj` source via Xcode or by editing pbxproj directly — the extension will regenerate Package.swift to match.
- **Why Package.swift exists at all**: it is a *shadow project* used solely to populate SourceKit-LSP's index store for cross-file intellisense. Actual app builds go through `xcodebuild`. Resources, swift settings, etc. in Package.swift do not affect what ships.

### Pbxproj sync on Swift file create/delete
- **What**: When the user creates or deletes a `.swift` file inside a target's directory, the extension automatically updates `project.pbxproj` (adds/removes the four required entries: `PBXBuildFile`, `PBXFileReference`, `PBXGroup` child entry, `PBXSourcesBuildPhase` entry).
- **Don't manually edit pbxproj to register a new Swift file.** Just create the file in the right directory; the extension's `FileSystemWatcher` (debounced 300ms, write-serialized) handles the pbxproj update.
- **Exception**: targets using Xcode 16+ file system synchronized groups (`PBXFileSystemSynchronizedRootGroup`) need no pbxproj entry at all — Xcode auto-discovers files in the directory. The extension correctly skips pbxproj sync for these targets.

### SourceKit-LSP server arguments
- **What**: The extension writes `swift.sourcekit-lsp.serverArguments` into `.vscode/settings.json` with iOS-simulator SDK paths, target triple, framework search paths, and XCTest overlay paths.
- **Don't manually edit `swift.sourcekit-lsp.serverArguments`.** It will be overwritten on next Package.swift regeneration.
- If you switch Xcode versions (`sudo xcode-select -s ...`), trigger a regeneration via the `Swift: Generate Package.swift from Xcode Project` command so the SDK paths refresh.

### swift-format integration
- **What**: VSXcode bundles its own `DocumentFormattingEditProvider` for swift-format (binary auto-detection from PATH/Homebrew, workspace/project config file discovery, format-on-save support, lint mode).
- **Don't suggest the user install a separate swift-format extension.** It's already wired up.
- The Code Format sidebar panel is a webview that lets the user toggle individual swift-format rules. Configuration ends up in `.vscode/.swift-format` (JSON).

### Workspace-state persistence
- **What**: Selected project, target, scheme, simulator/device, Swift version, and strict-concurrency setting are persisted in VS Code workspace state (not in any file the user can edit). Auto-detected on first activation.
- **Bundle id is NOT cached.** It's read live from `project.pbxproj` on every read, and from the freshly-built `.app/Info.plist` on every install/launch/terminate. Edits to `PRODUCT_BUNDLE_IDENTIFIER` take effect immediately with no resync step.
- **Don't try to write these to `.vscode/settings.json` or any other file.** They live in the extension's `BuildTaskConfig` workspace state.

### Xcode 26 Icon Composer (`.icon`) and synchronized-target loose resources
- The extension auto-classifies `.icon` directories as `.copy` resources in the generated Package.swift.
- For targets using synchronized groups, loose non-source files (`.js`, `.css`, etc.) inside the target dir are auto-added as resources, mirroring xcodebuild's "include everything in the folder" semantics.

---

## Capabilities to leverage — use these instead of raw shell

### Build / run / debug

The extension contributes a custom `xcode-build` task type with four subtasks. When the user wants to build, run, or debug, **suggest invoking these tasks** (via the VS Code Tasks UI, or by adding to `.vscode/tasks.json`) rather than constructing raw `xcodebuild` shell commands. The tasks already handle scheme detection, DerivedData isolation per scheme, simulator boot, app install via `xcrun simctl` / `devicectl`, console attachment, and lldb-dap debug session lifecycle.

| Task type | `task` value | What it does |
|---|---|---|
| `xcode-build` | `build` | Compile only. No install, no run. |
| `xcode-build` | `build-install` | Compile and install to simulator/device. |
| `xcode-build` | `run-and-debug` | Compile, install, launch with lldb-dap attached. Triggers automatically after `build-install` succeeds. |
| `xcode-build` | `test` | Run XCTest suite via `xcodebuild test`. |

Example `.vscode/tasks.json` entry:
```json
{
  "type": "xcode-build",
  "task": "build",
  "label": "Build",
  "group": { "kind": "build", "isDefault": true }
}
```

### Keybindings the user has wired up

When `vsxcode.buildTasksConfigured` is true (auto-set after first activation):

- **`Cmd+R`** → `vsxcode.sidebar.buildAndRun` (build, install, run, debug)
- **`Cmd+Shift+B`** → `vsxcode.sidebar.build`

Suggest these keybindings instead of "open terminal and run xcodebuild …" workflows.

### Commands the agent can invoke

User-facing commands (palette and programmatic):

| Command ID | Purpose |
|---|---|
| `vsxcode.createFromXcodeproj` | Generate Package.swift (Debug config) |
| `vsxcode.createFromXcodeprojWithOptions` | Generate Package.swift with QuickPick config selection |
| `vsxcode.generateBuildTasks` | Interactive build-task configuration wizard |
| `vsxcode.sidebar.changeProject` | Select a different `.xcodeproj` |
| `vsxcode.sidebar.changeTarget` | Select a different target within current project |
| `vsxcode.sidebar.changeScheme` | Select a different scheme |
| `vsxcode.sidebar.changeBundleId` | Edit `PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj` |
| `vsxcode.sidebar.uninstallStaleAppsOnSimulator` | Uninstall orphan apps left on the selected simulator after a bundle id rename |
| `vsxcode.sidebar.selectSimulator` | Pick simulator or physical device |
| `vsxcode.sidebar.changeSwiftVersion` | Pick Swift compiler version (toolchain switch) |
| `vsxcode.sidebar.changeStrictConcurrency` | Set strict-concurrency level |
| `vsxcode.sidebar.build` | Build (same as `Cmd+Shift+B`) |
| `vsxcode.sidebar.buildAndRun` | Build & run with debugger (same as `Cmd+R`) |
| `vsxcode.sidebar.refresh` | Refresh sidebar UI |

Invoke programmatically with:
```ts
vscode.commands.executeCommand('vsxcode.sidebar.build');
```
Or suggest the user run them from the Command Palette (`Cmd+Shift+P`).

### Sidebar UI

There's a "VSXcode" activity-bar item with two views when an Xcode project is detected:
- **Xcode Build** — Tree view showing current project, target, scheme, bundle ID, swift version, strict concurrency, device. Each row is clickable to change the corresponding setting. The Bundle ID row reads from `project.pbxproj` and shows a warning when an app with the same product name but different bundle id is installed on the selected simulator (typically an orphan from a previous rename); clicking the warning offers to uninstall it.
- **Code Format** — Webview for swift-format rule configuration and the Homebrew install button.

When the user asks to change build configuration, suggest the sidebar instead of editing config files.

### Test integration

- The extension contributes a `vscode.TestController` that discovers XCTest targets from pbxproj.
- Tests appear in the **Testing** sidebar (`testing` view). The user can run, debug, and view code coverage from there.
- Coverage uses `xccov` and surfaces inline in the editor.
- For test-related tasks, **prefer the Testing sidebar** over manually invoking `xcodebuild test`.

### Debug attachment

- Implemented via a `vscode.DebugConfigurationProvider` for `lldb-dap`.
- The `run-and-debug` task automatically launches and attaches the debugger; you do **not** need to write `.vscode/launch.json` entries by hand for normal app debugging.
- Auto-continues past SIGSTOP, internal-breakpoint stops, and initial attach stops on physical-device launches (gated on `configurationDone` ack to avoid races).

### Format-on-save

- swift-format is the formatter. Format-on-save is supported through the contributed provider.
- The user can configure rules via the Code Format sidebar panel (which writes to `.vscode/.swift-format`).

---

## Quick decision guide

Before doing one of these manually, check the table:

| You want to… | Use this instead of raw shell |
|---|---|
| Build the app | Run task `xcode-build` / `build` (or `Cmd+Shift+B`) |
| Build, install, and run | Run task `xcode-build` / `run-and-debug` (or `Cmd+R`) |
| Run tests | Use the Testing sidebar (or task `xcode-build` / `test`) |
| Switch simulator/device | Run command `vsxcode.sidebar.selectSimulator` |
| Switch scheme | Run command `vsxcode.sidebar.changeScheme` |
| Update Package.swift to reflect a pbxproj change | Do nothing — the watcher regenerates automatically |
| Add a Swift file to a target | Just create the file in the right directory — pbxproj is updated automatically |
| Format Swift code | Save the file (format-on-save) or invoke "Format Document" |
| Configure swift-format rules | Open the **Code Format** sidebar panel |
| Refresh SourceKit-LSP after Xcode version switch | Run command `vsxcode.createFromXcodeproj` to regenerate Package.swift + serverArguments |

---

## Things the extension does NOT do (so you should)

- It does not run `xcrun simctl boot` for arbitrary simulators outside the build flow — if you need a simulator booted independently, use the shell.
- It does not modify Swift code itself (other than via swift-format). Refactors, fixes, feature work — that's still your job.
- It does not manage Swift Package Manager dependencies (`Package.resolved` is written by SwiftPM during background index builds; remote/local SPM deps come from the `.xcodeproj`).
- It does not manage signing certificates, provisioning profiles, or App Store Connect interactions.
- It does not run `git` operations.

---

## Where to look in the workspace

| Path | Purpose |
|---|---|
| `Package.swift` | Generated. Read-only from your perspective. |
| `.vscode/settings.json` | Contains `swift.sourcekit-lsp.serverArguments` written by the extension. Read-only for that key. |
| `.vscode/.swift-format` | swift-format rule config (JSON). Edit via Code Format sidebar; raw edits also fine. |
| `.vscode/tasks.json` | Optional. Add `xcode-build` task entries here if you want explicit task definitions. |
| `<project>.xcodeproj/project.pbxproj` | Source of truth for project structure. The extension reads it and (for Swift file create/delete on non-synchronized targets) writes to it. |

---

## Version

This document describes VSXcode v3.6.2. Behavior is stable across patch versions; if a fundamental capability changes, this file will be updated.
