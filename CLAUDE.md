# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

- `npm run compile` — Build TypeScript from `src/` to `out/`
- `npm run watch` — Rebuild on file changes
- `npm run package` — Package as `.vsix` for distribution

No test framework or linter is configured.

**Version bumps**: When bumping the version number, update it in **all** locations: `package.json`, `README.md`, and any other files that reference the version. Search the repo to ensure nothing is missed.

**Important**: After every code change, always compile, package, and install the extension into VS Code:
```
find . -maxdepth 1 -name "*.vsix" -delete && npm run compile && npm run package && code --install-extension *.vsix --force
```

**Before committing**: Always launch an independent subagent to audit the staged diff before running `git commit`. The subagent should review the changes, read relevant surrounding files for full context, and check for bugs, logic gaps, unintended side effects, and issues beyond just the changed lines. Only commit after the audit passes clean.

## Architecture

VS Code extension that parses Xcode `.xcodeproj` files and generates `Package.swift` manifests and build/debug task configurations for iOS simulator development. Requires macOS with Xcode installed. No runtime dependencies — only VS Code API and Node.js built-ins.

**Data flow**: Read `project.pbxproj` (ASCII plist) → regex-based parsing into structured data → formatted Swift/JSON output → diff view → user confirmation → write file. Bidirectional: `.swift` file additions/removals are synced back into `project.pbxproj` via string manipulation.

### Entry Point

`src/extension.ts` — Orchestrator (~1500 lines) that registers all commands, providers, and watchers. Contains two main workflows:

1. **generatePackageSwift** — Parses pbxproj, builds Package.swift, configures SourceKit-LSP for iOS simulator SDK
2. **configureBuildTasks** — Interactive setup of project/target/scheme/simulator, stores `BuildTaskConfig` to workspace state

Also contains inline helpers: `parseDefaultLocalization`, `parseDeploymentTargets`, `parseExcludedFiles`, `generateCSettings`, `resolveSwiftLanguageMode`, `formatProductType`, `printToSharedPanel`, `cancelActiveRun`, `executeTaskAndWait`.

### Commands

| Command | Description |
|---------|-------------|
| `vsxcode.createFromXcodeproj` | Generate Package.swift (Debug config) |
| `vsxcode.createFromXcodeprojWithOptions` | Generate Package.swift (QuickPick config selection) |
| `vsxcode.generateBuildTasks` | Interactive build task configuration |
| `vsxcode.sidebar.*` | 15 sidebar commands: changeProject, changeTarget, changeScheme, changeBundleId, toggleDevBundleId (+ enableDevBundleId/disableDevBundleId inline wrappers), uninstallStaleAppsOnSimulator, selectSimulator, changeSwiftVersion, changeStrictConcurrency, build, buildAndRun, refresh, cleanDerivedData |

### Module Map

```
src/
├── extension.ts                 — Main orchestrator, command registration, workflows
├── types/
│   ├── interfaces.ts            — All TS interfaces (NativeTarget, BuildSettings, TargetOutput, BuildTaskConfig, etc.)
│   └── constants.ts             — Platform mappings, IMPLICIT_FRAMEWORKS, SWIFT_VERSION_MAP,
│                                  resource extensions, SPM source/exclude/resource constants
├── parsers/
│   ├── base.ts                  — extractObjectBody (brace-matching), parsePackageRequirement, parseListValue
│   ├── buildSettings.ts         — XCBuildConfiguration parsing, mergeWithInherited, project/target settings
│   ├── targets.ts               — PBXNativeTarget parsing, isTestTarget, target dependencies, build phase IDs
│   ├── packages.ts              — XCRemoteSwiftPackageReference + XCLocalSwiftPackageReference + product deps
│   ├── frameworks.ts            — PBXFrameworksBuildPhase parsing, framework name extraction
│   ├── resources.ts             — PBXResourcesBuildPhase parsing, resource type classification,
│   │                              scanForUnhandledFiles (filesystem scan for SPM compatibility)
│   └── groups.ts                — PBXGroup hierarchy parsing, path-to-group resolution
├── generators/
│   ├── packageSwift.ts          — Main Package.swift builder (platforms, products, deps, targets)
│   ├── swiftSettings.ts         — .define(), .unsafeFlags() from build settings
│   ├── linkerSettings.ts        — .linkedFramework() from linked frameworks
│   ├── resources.ts             — Resource entry formatting (.process/.copy)
│   └── buildTasks.ts            — xcodebuild shell commands (build, build-install, run-and-debug)
├── writers/
│   └── pbxproj.ts               — pbxproj modification: add/remove PBXBuildFile, PBXFileReference,
│                                  PBXGroup children, PBXSourcesBuildPhase entries; ID generation
├── sync/
│   └── swiftFileSync.ts         — FileSystemWatcher for *.swift, target-directory mapping,
│                                  orchestrates pbxproj updates on file create/delete
├── providers/
│   ├── taskProvider.ts          — vscode.TaskProvider for xcode-build task type (4 subtasks)
│   ├── debugConfigProvider.ts   — vscode.DebugConfigurationProvider for lldb-dap attach configs
│   ├── sidebarProvider.ts       — vscode.TreeDataProvider for sidebar UI + autoConfigureBuildTasks
│   ├── swiftFormatProvider.ts   — DocumentFormattingEditProvider for swift-format (format-on-save,
│   │                              binary detection, config file management, lint mode)
│   ├── codeQualityWebviewProvider.ts — WebviewViewProvider for Code Format sidebar panel
│   │                              (swift-format config UI, rule toggles, Homebrew install)
│   └── testController.ts        — vscode.TestController for XCTest discovery, execution,
│                                  result parsing, and xccov code coverage integration
└── utils/
    ├── version.ts               — Swift/macOS version detection via xcrun, version comparison, cleanup()
    ├── path.ts                  — Target path resolution (Sources/, Tests/, shared conventions)
    └── simulator.ts             — iOS simulator enumeration via xcrun simctl
```

### Key Patterns

- **Build settings inheritance**: Debug/Release configs merge with project-level defaults via `mergeWithInherited`, respecting `$(inherited)`
- **Resource classification**: Files classified as `.process` (compilable: xcassets, storyboard, xib, strings, xcdatamodeld) or `.copy` (everything else)
- **Filesystem scanning**: After pbxproj parsing, `scanForUnhandledFiles` walks target directories to auto-exclude Xcode-specific files (Info.plist, .entitlements, .pch) and auto-include bundle-like resource directories (.xcdatamodeld, .xcassets, .lproj, etc.) that SPM can't auto-categorize
- **Auto-sync (pbxproj → Package.swift)**: FileSystemWatcher on `*.pbxproj` triggers silent Package.swift regeneration
- **Auto-sync (Swift files → pbxproj)**: FileSystemWatcher on `*.swift` detects file create/delete in target directories and updates pbxproj (4 entries: PBXBuildFile, PBXFileReference, PBXGroup, PBXSourcesBuildPhase). Handles subdirectories via PBXGroup tree resolution. Debounced (300ms) with write serialization.
- **Auto-configure**: On activation, auto-detects first project/target/simulator and stores `BuildTaskConfig` to workspace state
- **Task chaining**: build-install completion triggers run-and-debug; debug session end kills debugserver
- **Physical device support**: Build → install via devicectl → poll device ready → launch console → attach lldb-dap
- **SourceKit-LSP**: Auto-configures `swift.sourcekit-lsp.serverArguments` with iOS simulator SDK paths for intellisense
- **swift-format**: Auto-detects binary, discovers workspace/project config files, format-on-save via DocumentFormattingEditProvider, webview UI for rule configuration in sidebar
- **XCTest integration**: Discovers test targets from pbxproj, runs via xcodebuild, parses results (xcresulttool), xccov code coverage
- **Diff view**: Shows current vs generated Package.swift before overwriting
- **Activation**: `workspaceContains:**/*.pbxproj` and `onDebug`

### Package.swift Features

Swift settings (.define, .unsafeFlags, .swiftLanguageMode), linked frameworks (.linkedFramework), resources (.process/.copy), header search paths (.headerSearchPath), target dependencies (.target(name:)), excluded files, Swift package dependencies (remote + local), deployment targets, default localization, multi-configuration support (Debug/Release).

### Build & Debug Features

Custom `xcode-build` task type with build/build-install/run-and-debug/test subtasks, lldb-dap debug attachment, simulator boot + app install via xcrun simctl, physical device support via devicectl, DerivedData isolation per scheme, Cmd+R and Cmd+Shift+B keybindings, sidebar UI for configuration management, XCTest controller with code coverage.
