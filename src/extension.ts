import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsp } from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';

const execFile = promisify(execFileCallback);

import type {
    TargetDefinition,
    TargetOutput,
    ProductDefinition,
    SwiftPackageProductDependency
} from './types/interfaces';
import { DEFAULT_SWIFT_VERSION } from './types/constants';
import { detectSwiftToolsVersion, detectMacOSVersion, parseSwiftVersion, cleanup, compareVersions, isXcodeFirstLaunchNeeded, isXcodeFirstLaunchComplete } from './utils/version';
import { determineTargetPath } from './utils/path';
import { parseNativeTargets, isTestTarget, mapProductType, parseTargetDependencies, parseBuildPhaseIds } from './parsers/targets';
import { parseSwiftPackageReferences, parseSwiftPackageProductDependencies } from './parsers/packages';
import { getBuildSettingsForTarget, getProjectBuildSettings, resolveConfigurationListId, platformsSupported } from './parsers/buildSettings';
import { extractObjectBody } from './parsers/base';
import { parseLinkedFrameworksForTarget } from './parsers/frameworks';
import { parseResourcesForTarget, scanForUnhandledFiles } from './parsers/resources';
import { generateSwiftSettings } from './generators/swiftSettings';
import { generateLinkerSettings } from './generators/linkerSettings';
import { buildPackageSwift, formatPackageDependencyEntry } from './generators/packageSwift';
import { listAvailableSimulators, listPhysicalDevices, devicectlInstall, checkDeviceReady, findDeviceSymbols, getMyMacDestination } from './utils/simulator';
import { getDestinationType, builtAppPath, derivedDataBasePath } from './utils/destination';
import { XcodeBuildTaskProvider, TASK_TYPE } from './providers/taskProvider';
import { XcodeDebugConfigProvider } from './providers/debugConfigProvider';
import { SidebarProvider, autoConfigureBuildTasks, promptXcodeFirstLaunch } from './providers/sidebarProvider';
import { XCTestController } from './providers/testController';
import { updateBuildSetting } from './writers/pbxproj';
import { createSwiftFileWatcher, reconcileSwiftFiles } from './sync/swiftFileSync';
import { SwiftFormatProvider } from './providers/swiftFormatProvider';
import { CodeQualityWebviewProvider } from './providers/codeQualityWebviewProvider';
import {
    resolveBundleIdForLaunch,
    parseBundleIdFromPbxproj,
    listInstalledSimulatorApps,
    uninstallSimulatorApp,
    readInfoPlistBundleId,
    getInstalledAppExecutableMtime,
    formatMtime,
    readInfoPlistDisplayNames,
    readInfoPlistExecutable,
    effectiveBundleId,
    counterpartBundleId,
    DEV_BUNDLE_ID_SUFFIX,
} from './utils/bundleId';
import type { BuildTaskConfig, DestinationType } from './types/interfaces';

import type { PlatformName, DeploymentTarget } from './types/interfaces';
import { PLATFORM_KEYS, DEFAULT_PLATFORM } from './types/constants';

function parseDefaultLocalization(pbxContents: string): string | null {
    const projectRegex = /\/\* Begin PBXProject section \*\/([\s\S]*?)\/\* End PBXProject section \*\//;
    const projectMatch = projectRegex.exec(pbxContents);
    if (!projectMatch) {
        return null;
    }
    const projectSection = projectMatch[1];
    const localizationMatch = /developmentRegion = ([^;]+);/.exec(projectSection);
    if (localizationMatch) {
        return cleanup(localizationMatch[1]);
    }
    return null;
}

function parseDeploymentTargets(pbxContents: string): DeploymentTarget[] {
    const found = new Map<PlatformName, string>();
    const entries = Object.entries(PLATFORM_KEYS) as Array<[string, PlatformName]>;
    for (const [key, platform] of entries) {
        const regex = new RegExp(`${key} = ([^;]+);`, 'g');
        let match: RegExpExecArray | null;
        while ((match = regex.exec(pbxContents)) !== null) {
            const version = cleanup(match[1]);
            if (!version) {
                continue;
            }
            const current = found.get(platform);
            if (!current || compareVersions(version, current) > 0) {
                found.set(platform, version);
            }
        }
    }
    if (found.size === 0) {
        found.set(DEFAULT_PLATFORM.platform, DEFAULT_PLATFORM.version);
    }
    return Array.from(found.entries()).map(([platform, version]) => ({ platform, version }));
}

// Required for SourceKit-LSP intellisense on iOS-only packages: its background
// index build runs `swift build` against the host platform, which fails to
// plan without macOS — leaving the user's target unindexed.
async function ensureMacOSPlatform(platforms: DeploymentTarget[]): Promise<DeploymentTarget[]> {
    const detectedVersion = await detectMacOSVersion();
    if (!detectedVersion) {
        return platforms;
    }
    const next = platforms.slice();
    const macIndex = next.findIndex(({ platform }) => platform === 'macOS');
    const macEntry: DeploymentTarget = { platform: 'macOS', version: detectedVersion };
    if (macIndex === -1) {
        next.push(macEntry);
    } else {
        next[macIndex] = macEntry;
    }
    return next;
}

function resolveSwiftLanguageMode(swiftVersion: string | undefined): string | undefined {
    if (!swiftVersion) {
        return undefined;
    }
    const major = parseInt(swiftVersion.split('.')[0], 10);
    return isNaN(major) ? undefined : `.v${major}`;
}

function formatProductType(productType: string): string {
    if (productType.includes('unit-test')) { return 'Unit Tests'; }
    if (productType.includes('ui-testing')) { return 'UI Tests'; }
    if (productType.includes('.test')) { return 'Tests'; }
    if (productType.includes('.application')) { return 'Application'; }
    if (productType.includes('.framework')) { return 'Framework'; }
    if (productType.includes('.library')) { return 'Library'; }
    if (productType.includes('.app-extension')) { return 'App Extension'; }
    if (productType.includes('.widget-extension')) { return 'Widget Extension'; }
    return '';
}

function parseExcludedFiles(pbxContents: string, targetName: string): string[] {
    const exceptionRegex =
        /\/\* Begin PBXFileSystemSynchronizedBuildFileExceptionSet section \*\/([\s\S]*?)\/\* End PBXFileSystemSynchronizedBuildFileExceptionSet section \*\//;
    const exceptionMatch = exceptionRegex.exec(pbxContents);
    if (!exceptionMatch) {
        return [];
    }
    const section = exceptionMatch[1];

    // Parse each exception set entry individually, filtering by target name.
    // Uses brace-depth tracking to handle nested {} (e.g. attributesByRelativePath).
    const entryStartRegex =
        /([A-F0-9]{24})\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{/g;
    const excluded: string[] = [];
    let entry: RegExpExecArray | null;
    while ((entry = entryStartRegex.exec(section)) !== null) {
        const result = extractObjectBody(section, entry.index);
        if (!result) { continue; }
        const body = result.body;

        const targetMatch = /target\s*=\s*[A-F0-9]{24}\s*\/\*\s*([^*]+)\s*\*\/\s*;/.exec(body);
        if (!targetMatch || targetMatch[1].trim() !== targetName) {
            continue;
        }

        const exceptionsMatch = /membershipExceptions\s*=\s*\(([\s\S]*?)\);/.exec(body);
        if (!exceptionsMatch) {
            continue;
        }

        // Match both quoted ("Info.plist") and unquoted (Info.plist) paths
        const pathRegex = /(?:"([^"]+)"|([A-Za-z0-9_./+-]+))\s*,?/g;
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = pathRegex.exec(exceptionsMatch[1])) !== null) {
            const filePath = pathMatch[1] || pathMatch[2];
            if (filePath) {
                excluded.push(filePath);
            }
        }
    }
    return excluded;
}

function generateCSettings(headerSearchPaths: string[] | undefined): string[] {
    if (!headerSearchPaths || headerSearchPaths.length === 0) {
        return [];
    }
    const filtered = headerSearchPaths.filter(
        (p) => p !== '$(inherited)' && p.length > 0
    );
    return filtered.map((p) => `.headerSearchPath("${p}")`);
}

function currentDestinationType(workspaceState: vscode.Memento): DestinationType {
    const config = workspaceState.get<BuildTaskConfig>('buildTaskConfig');
    return config ? getDestinationType(config) : 'simulator';
}

/**
 * Point SourceKit-LSP at the SDK matching the selected run destination.
 * macOS indexes against the host SDK (we clear our iOS override so SwiftPM
 * uses the default macOS toolchain); iOS destinations resolve against the
 * iPhoneSimulator SDK. macOS stays in the package's platform list so
 * mac-only indexing resolves.
 */
async function configureSourceKitLSP(dest: DestinationType, platforms: DeploymentTarget[]): Promise<void> {
    const lspConfig = vscode.workspace.getConfiguration('swift.sourcekit-lsp');

    // Removing a setting that isn't present still creates an empty
    // .vscode/settings.json, so only clear when a workspace value exists.
    const clearIfPresent = async () => {
        if (lspConfig.inspect('serverArguments')?.workspaceValue !== undefined) {
            await lspConfig.update('serverArguments', undefined, vscode.ConfigurationTarget.Workspace);
        }
    };

    if (dest === 'mac') {
        await clearIfPresent();
        return;
    }

    const iosPlatform = platforms.find((p) => p.platform === 'iOS');
    if (!iosPlatform) {
        // Nothing iOS to target — clear the override (defaults to host macOS).
        await clearIfPresent();
        return;
    }
    try {
        const cp = await import('child_process');
        const developerDir = cp.execSync('xcode-select -p', { encoding: 'utf8' }).trim();
        const sdkPath = `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk`;
        const simulatorTarget = `arm64-apple-ios${iosPlatform.version}-simulator`;
        const serverArguments = [
            '-Xswiftc', '-sdk',
            '-Xswiftc', sdkPath,
            '-Xswiftc', '-target',
            '-Xswiftc', simulatorTarget,
            '-Xswiftc', '-F',
            '-Xswiftc', `${sdkPath}/System/Library/Frameworks`,
            '-Xswiftc', '-F',
            '-Xswiftc', `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/Library/Frameworks`,
            '-Xswiftc', '-I',
            '-Xswiftc', `${developerDir}/Platforms/iPhoneSimulator.platform/Developer/usr/lib`,
            '-Xswiftc', '-enable-testing'
        ];
        await lspConfig.update('serverArguments', serverArguments, vscode.ConfigurationTarget.Workspace);
    } catch {
        vscode.window.showWarningMessage(
            'Could not configure SourceKit-LSP: xcode-select failed. Run "xcode-select --install" in Terminal to install command-line tools.'
        );
    }
}

/**
 * Reconfigure SourceKit-LSP to match the config's destination without
 * regenerating Package.swift.
 */
async function reconfigureSourceKitLSP(projectRoot: string, config: BuildTaskConfig): Promise<void> {
    const dest = getDestinationType(config);
    let platforms: DeploymentTarget[] = [];
    if (dest !== 'mac') {
        // Only the iOS branch needs the deployment version for the triple.
        try {
            const pbx = await fsp.readFile(path.join(projectRoot, config.projectFile, 'project.pbxproj'), 'utf8');
            platforms = parseDeploymentTargets(pbx);
        } catch { /* ignore — configureSourceKitLSP clears when no iOS platform */ }
    }
    await configureSourceKitLSP(dest, platforms);
}

async function generatePackageSwift(rootPath: string, configurationName: string = 'Debug', silent: boolean = false, destinationType: DestinationType = 'simulator'): Promise<void> {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const xcodeProjects = entries.filter(
        (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
    );
    if (xcodeProjects.length === 0) {
        throw new Error('No .xcodeproj found in the workspace root.');
    }

    let selectedProject = xcodeProjects[0].name;
    if (xcodeProjects.length > 1 && !silent) {
        const pick = await vscode.window.showQuickPick(
            xcodeProjects.map((entry) => entry.name),
            { placeHolder: 'Select the Xcode project to read' }
        );
        if (!pick) {
            return;
        }
        selectedProject = pick;
    }

    const pbxprojPath = path.join(rootPath, selectedProject, 'project.pbxproj');
    let pbxContents: string;
    try {
        pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
    } catch (error) {
        const message = (error as { message?: string }).message;
        throw new Error(`Unable to read ${pbxprojPath}: ${message}`);
    }

    const swiftVersion =
        (await detectSwiftToolsVersion()) || parseSwiftVersion(pbxContents) || DEFAULT_SWIFT_VERSION;
    const platforms = await ensureMacOSPlatform(parseDeploymentTargets(pbxContents));
    const defaultLocalization = parseDefaultLocalization(pbxContents);
    const nativeTargets = parseNativeTargets(pbxContents);
    const packageReferences = parseSwiftPackageReferences(pbxContents);
    const packageProductDependencies = parseSwiftPackageProductDependencies(pbxContents);
    const targetDependencies = parseTargetDependencies(pbxContents);
    const projectBuildSettings = getProjectBuildSettings(pbxContents, configurationName);

    if (nativeTargets.length === 0) {
        throw new Error('No native targets found in the Xcode project.');
    }

    const packageName = path.basename(selectedProject, '.xcodeproj');

    const targetDefinitions: TargetDefinition[] = nativeTargets.map((target) => {
        const testTarget = isTestTarget(target.productType);
        const targetPackageDependencies =
            target.packageProductDependencyIds && target.packageProductDependencyIds.length > 0
                ? target.packageProductDependencyIds
                      .map((dependencyId) => packageProductDependencies.get(dependencyId))
                      .filter(
                          (dependency): dependency is SwiftPackageProductDependency => Boolean(dependency)
                      )
                      .map((dependency) => {
                          const packageRef = dependency.packageRef
                              ? packageReferences.get(dependency.packageRef)
                              : undefined;
                          const packageNameValue = (
                              (packageRef && packageRef.name) ||
                              dependency.packageName ||
                              dependency.productName
                          ) as string;
                          return `.product(name: "${dependency.productName}", package: "${packageNameValue}")`;
                      })
                : [];

        const nativeTargetDeps = targetDependencies.get(target.name) || [];
        const targetDepStrings = nativeTargetDeps.map(
            (dep) => `.target(name: "${dep.targetName}")`
        );

        const uniqueDependencies = Array.from(new Set([...targetDepStrings, ...targetPackageDependencies]));
        return {
            name: target.name,
            productName: target.productName,
            productType: target.productType,
            spmType: testTarget ? '.testTarget' as const : '.target' as const,
            path: determineTargetPath(rootPath, target.name, testTarget, target.productName),
            isTest: testTarget,
            dependencies: uniqueDependencies
        };
    });

    const productMap = new Map<string, ProductDefinition>();
    for (const target of targetDefinitions) {
        if (target.isTest) {
            continue;
        }
        const type = mapProductType(target.productType);
        if (!productMap.has(target.productName)) {
            productMap.set(target.productName, {
                type,
                name: target.productName,
                targets: [target.name]
            });
        } else {
            const existing = productMap.get(target.productName);
            if (existing && !existing.targets.includes(target.name)) {
                existing.targets.push(target.name);
            }
        }
    }

    const products = Array.from(productMap.values());
    const packageDependenciesList = Array.from(packageReferences.values())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((reference) => formatPackageDependencyEntry(reference))
        .filter((entry): entry is string => Boolean(entry));
    const uniquePackageDependencies = Array.from(new Set(packageDependenciesList));

    // Resolve developer dir for XCTest framework and Swift overlay paths in test targets
    let xcTestFrameworkPath: string | undefined;
    let xcTestSwiftOverlayPath: string | undefined;
    try {
        const cp = await import('child_process');
        const developerDir = cp.execSync('xcode-select -p', { encoding: 'utf8' }).trim();
        const platformDir = `${developerDir}/Platforms/iPhoneSimulator.platform/Developer`;
        xcTestFrameworkPath = `${platformDir}/Library/Frameworks`;
        xcTestSwiftOverlayPath = `${platformDir}/usr/lib`;
    } catch { /* xcode-select not available */ }

    // Emit test targets as .target() with XCTest unsafeFlags instead of .testTarget().
    // This preserves SourceKit-LSP IntelliSense (XCTest types, @testable import) while
    // preventing the Swift extension from discovering them as tests (it only scans .testTarget).
    for (const targetDef of targetDefinitions) {
        if (targetDef.isTest) {
            targetDef.spmType = '.target' as const;
        }
    }

    const targetOutputs: TargetOutput[] = nativeTargets.map((nativeTarget) => {
        const targetDef = targetDefinitions.find((t) => t.name === nativeTarget.name)!;
        const buildPhases = parseBuildPhaseIds(pbxContents, nativeTarget.name);
        const targetSettings = nativeTarget.buildConfigurationListId
            ? getBuildSettingsForTarget(pbxContents, nativeTarget.buildConfigurationListId, configurationName)
            : null;

        const swiftSettings = generateSwiftSettings(projectBuildSettings, targetSettings, configurationName);
        const linkedFrameworks = parseLinkedFrameworksForTarget(pbxContents, buildPhases.frameworksBuildPhaseId);
        const targetAbsolutePath = path.join(rootPath, targetDef.path);
        const resources = parseResourcesForTarget(pbxContents, buildPhases.resourcesBuildPhaseId, targetAbsolutePath);
        const excluded = parseExcludedFiles(pbxContents, nativeTarget.name);

        const isSynchronized = nativeTarget.fileSystemSynchronizedGroupIds.length > 0;
        const { additionalExcludes, additionalResources } = scanForUnhandledFiles(
            targetAbsolutePath, resources, excluded, isSynchronized
        );
        const allResources = [...resources, ...additionalResources];
        const allExcludes = [...excluded, ...additionalExcludes];

        const headerPaths = targetSettings?.headerSearchPaths;
        const cSettings = generateCSettings(headerPaths);

        const swiftLangVersion = targetSettings?.swiftVersion;
        const swiftLanguageMode = resolveSwiftLanguageMode(swiftLangVersion);
        if (swiftLanguageMode) {
            swiftSettings.unshift(`.swiftLanguageMode(${swiftLanguageMode})`);
        }

        const strictConcurrency = targetSettings?.strictConcurrency || projectBuildSettings?.strictConcurrency;
        const effectiveVersion = swiftLangVersion || swiftVersion;
        const majorVersion = parseInt(effectiveVersion.split('.')[0], 10);
        if (strictConcurrency && majorVersion < 6) {
            if (strictConcurrency === 'complete') {
                swiftSettings.push(`.enableUpcomingFeature("StrictConcurrency")`);
            } else if (strictConcurrency === 'targeted') {
                swiftSettings.push(`.unsafeFlags(["-strict-concurrency=targeted"])`);
            }
        }

        // Add XCTest framework search path, Swift overlay path, and -enable-testing for test targets
        if (targetDef.isTest && xcTestFrameworkPath && xcTestSwiftOverlayPath) {
            swiftSettings.push(`.unsafeFlags(["-F", "${xcTestFrameworkPath}", "-I", "${xcTestSwiftOverlayPath}", "-enable-testing"])`);
        }

        const packageDependencyNames = new Set(
            Array.from(packageReferences.values()).map((ref) => ref.name)
        );
        const filteredFrameworks = linkedFrameworks.filter((name) => !packageDependencyNames.has(name));
        const linkerSettings = generateLinkerSettings(filteredFrameworks);

        return {
            spmType: targetDef.spmType,
            name: targetDef.name,
            path: targetDef.path,
            dependencies: targetDef.dependencies.length > 0 ? targetDef.dependencies : undefined,
            resources: allResources.length > 0 ? allResources : undefined,
            swiftSettings: swiftSettings.length > 0 ? swiftSettings : undefined,
            cSettings: cSettings.length > 0 ? cSettings : undefined,
            linkerSettings: linkerSettings.length > 0 ? linkerSettings : undefined,
            exclude: allExcludes.length > 0 ? allExcludes : undefined
        };
    });

    const packageContents = buildPackageSwift({
        packageName,
        swiftVersion,
        platforms,
        products,
        dependencies: uniquePackageDependencies,
        targets: targetOutputs,
        defaultLocalization: defaultLocalization || undefined
    });

    // Point SourceKit-LSP at the SDK matching the selected run destination.
    await configureSourceKitLSP(destinationType, platforms);

    const packagePath = path.join(rootPath, 'Package.swift');

    if (fs.existsSync(packagePath)) {
        const existingContents = await fsp.readFile(packagePath, 'utf8');
        if (existingContents === packageContents) {
            if (!silent) {
                vscode.window.showInformationMessage('Package.swift is already up to date.');
            }
            return;
        }

        if (!silent) {
            const existingUri = vscode.Uri.file(packagePath);
            const previewUri = vscode.Uri.parse(`untitled:Package.swift.preview`);
            const previewDoc = await vscode.workspace.openTextDocument(previewUri);
            const previewEditor = await vscode.window.showTextDocument(previewDoc, { preview: true });
            await previewEditor.edit((edit) => {
                edit.insert(new vscode.Position(0, 0), packageContents);
            });

            await vscode.commands.executeCommand(
                'vscode.diff',
                existingUri,
                previewUri,
                'Package.swift: Current vs Generated'
            );

            const overwrite = await vscode.window.showQuickPick(['Overwrite', 'Cancel'], {
                placeHolder: 'Package.swift already exists. Overwrite with generated version?'
            });

            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

            if (overwrite !== 'Overwrite') {
                return;
            }
        }
    }

    await fsp.writeFile(packagePath, packageContents, 'utf8');
    if (!silent) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(packagePath));
        await vscode.window.showTextDocument(document, { preview: false });
        vscode.window.showInformationMessage(`Package.swift generated from ${selectedProject}`);
    }
}

async function configureBuildTasks(rootPath: string, workspaceState: vscode.Memento): Promise<void> {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const xcodeProjects = entries.filter(
        (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
    );
    if (xcodeProjects.length === 0) {
        throw new Error('No .xcodeproj found in the workspace root.');
    }

    let selectedProject = xcodeProjects[0].name;
    if (xcodeProjects.length > 1) {
        const pick = await vscode.window.showQuickPick(
            xcodeProjects.map((entry) => entry.name),
            { placeHolder: 'Select the Xcode project' }
        );
        if (!pick) {
            return;
        }
        selectedProject = pick;
    }

    const pbxprojPath = path.join(rootPath, selectedProject, 'project.pbxproj');
    let pbxContents: string;
    try {
        pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
    } catch (error) {
        const message = (error as { message?: string }).message;
        throw new Error(`Unable to read ${pbxprojPath}: ${message}`);
    }

    const nativeTargets = parseNativeTargets(pbxContents);
    if (nativeTargets.length === 0) {
        throw new Error('No targets found in the Xcode project.');
    }

    const nonTestTargets = nativeTargets.filter((t) => !isTestTarget(t.productType));
    let selectedTarget = nonTestTargets[0] || nativeTargets[0];
    if (nativeTargets.length > 1) {
        type TargetPick = vscode.QuickPickItem & { targetName: string };
        const picks: TargetPick[] = nativeTargets.map((t) => ({
            label: t.name,
            description: formatProductType(t.productType),
            targetName: t.name,
        }));
        const activePick = picks.find(p => p.targetName === selectedTarget.name);
        const pick = await new Promise<TargetPick | undefined>((resolve) => {
            const qp = vscode.window.createQuickPick<TargetPick>();
            qp.items = picks;
            qp.placeholder = 'Select the target to build';
            if (activePick) { qp.activeItems = [activePick]; }
            qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.dispose(); });
            qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
            qp.show();
        });
        if (!pick) {
            return;
        }
        selectedTarget = nativeTargets.find((t) => t.name === pick.targetName)!;
    }

    let resolvedProductName = selectedTarget.productName || selectedTarget.name;
    if (selectedTarget.buildConfigurationListId) {
        const settings = getBuildSettingsForTarget(pbxContents, selectedTarget.buildConfigurationListId, 'Debug');
        if (settings?.productName && !settings.productName.includes('$(')) {
            resolvedProductName = settings.productName;
        }
    }

    const targetSettings = selectedTarget.buildConfigurationListId
        ? getBuildSettingsForTarget(pbxContents, selectedTarget.buildConfigurationListId, 'Debug')
        : null;
    const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
    const caps = platformsSupported(targetSettings, projectSettings);

    const [simulators, physicalDevices] = await Promise.all([
        listAvailableSimulators(),
        listPhysicalDevices(),
    ]);
    const macDest = caps.mac ? await getMyMacDestination() : null;
    if (simulators.length === 0 && physicalDevices.length === 0 && !macDest) {
        throw new Error('No available iOS devices found. Connect a device or install simulators via Xcode.');
    }

    const devicePicks: (vscode.QuickPickItem & { udid: string; deviceIdentifier: string; destinationType: DestinationType })[] = [];
    if (macDest) {
        devicePicks.push({ label: 'My Mac', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'mac' });
        devicePicks.push({ label: 'My Mac', description: `${macDest.name} · ${macDest.arch}`, udid: '', deviceIdentifier: '', destinationType: 'mac' });
    }
    if (physicalDevices.length > 0) {
        devicePicks.push({ label: 'Physical Devices', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'device' });
        for (const d of physicalDevices) {
            const transport = d.connectionType === 'wired' ? 'USB' : d.connectionType === 'localNetwork' ? 'Wi-Fi' : d.connectionType;
            devicePicks.push({ label: d.name, description: `iOS ${d.osVersion} (${transport})`, udid: d.udid, deviceIdentifier: d.deviceIdentifier, destinationType: 'device' });
        }
    }
    if (simulators.length > 0) {
        devicePicks.push({ label: 'Simulators', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'simulator' });
        for (const s of simulators) {
            devicePicks.push({ label: s.name, description: s.state, detail: s.runtime, udid: s.udid, deviceIdentifier: '', destinationType: 'simulator' });
        }
    }

    const simulatorPick = await vscode.window.showQuickPick(devicePicks, {
        placeHolder: 'Select device'
    });
    if (!simulatorPick) {
        return;
    }

    let schemes: string[] = [];
    try {
        const { stdout } = await execFile('xcodebuild', ['-list', '-project', path.join(rootPath, selectedProject)], { encoding: 'utf8', timeout: 10000 });
        const schemesMatch = /Schemes:\n([\s\S]*?)(?:\n\n|$)/.exec(stdout);
        if (schemesMatch) {
            schemes = schemesMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
        }
    } catch (error) {
        if (isXcodeFirstLaunchNeeded(error)) { promptXcodeFirstLaunch(); }
    }

    if (schemes.length === 0) {
        // Fallback: use target names as scheme names (Xcode auto-creates schemes per target)
        schemes = nativeTargets.map(t => t.name);
    }
    if (schemes.length === 0) {
        throw new Error('No schemes found in the Xcode project.');
    }

    let schemeName = schemes[0];
    if (schemes.length > 1) {
        const pick = await vscode.window.showQuickPick(schemes, {
            placeHolder: 'Select the scheme to build'
        });
        if (!pick) {
            return;
        }
        schemeName = pick;
    }

    const buildTaskConfig: BuildTaskConfig = {
        projectFile: selectedProject,
        schemeName,
        targetName: selectedTarget.name,
        productName: resolvedProductName,
        simulatorDevice: simulatorPick.label,
        simulatorUdid: simulatorPick.udid,
        isPhysicalDevice: simulatorPick.destinationType === 'device',
        deviceIdentifier: simulatorPick.deviceIdentifier,
        destinationType: simulatorPick.destinationType,
        // The wizard picks project/target/scheme/device; dev mode isn't one of
        // its prompts, so carry it over rather than silently reverting builds
        // to the shipping bundle id.
        devBundleId: workspaceState.get<BuildTaskConfig>('buildTaskConfig')?.devBundleId,
    };

    await workspaceState.update('buildTaskConfig', buildTaskConfig);
    await configureSourceKitLSP(buildTaskConfig.destinationType ?? 'simulator', parseDeploymentTargets(pbxContents));

    vscode.window.showInformationMessage(
        `Build tasks configured for ${selectedTarget.name} on ${simulatorPick.label}`
    );

    vscode.commands.executeCommand('setContext', 'vsxcode.buildTasksConfigured', true);

    if (!vscode.extensions.getExtension('llvm-vs-code-extensions.lldb-dap')) {
        const install = await vscode.window.showWarningMessage(
            'LLDB DAP extension is required for debugging. Install it?',
            'Install', 'Dismiss'
        );
        if (install === 'Install') {
            vscode.commands.executeCommand('workbench.extensions.installExtension', 'llvm-vs-code-extensions.lldb-dap');
        }
    }
}

let consoleExecution: vscode.TaskExecution | undefined;
let buildExecution: vscode.TaskExecution | undefined;
let currentRunId = 0;
let activeDebugSession: vscode.DebugSession | undefined;

function printToSharedPanel(message: string, color = '33'): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    const task = new vscode.Task(
        { type: 'xcode-message' },
        folder,
        'Print Message',
        'vsxcode',
        new vscode.CustomExecution(async () => {
            const writeEmitter = new vscode.EventEmitter<string>();
            const closeEmitter = new vscode.EventEmitter<number | void>();
            return {
                onDidWrite: writeEmitter.event,
                onDidClose: closeEmitter.event,
                open: () => {
                    writeEmitter.fire(`\r\n\x1b[${color}m${message}\x1b[0m\r\n\r\n`);
                    closeEmitter.fire(0);
                },
                close: () => {},
            };
        }),
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        showReuseMessage: false,
    };
    vscode.tasks.executeTask(task);
}

async function cancelActiveRun(): Promise<void> {
    currentRunId++;

    if (vscode.debug.activeDebugSession) {
        await vscode.debug.stopDebugging();
    }
    if (consoleExecution) {
        consoleExecution.terminate();
        consoleExecution = undefined;
    }
    if (buildExecution) {
        buildExecution.terminate();
        buildExecution = undefined;
    }
}

function executeTaskAndWait(task: vscode.Task, onStart?: (exec: vscode.TaskExecution) => void): Promise<number | undefined> {
    return new Promise(async (resolve) => {
        const listener = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution.task === task || event.execution.task.name === task.name) {
                listener.dispose();
                resolve(event.exitCode);
            }
        });
        const execution = await vscode.tasks.executeTask(task);
        onStart?.(execution);
    });
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) { return `${(bytes / 1024 ** 3).toFixed(1)} GB`; }
    if (bytes >= 1024 ** 2) { return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
    if (bytes >= 1024) { return `${Math.round(bytes / 1024)} KB`; }
    return `${bytes} B`;
}

// Sizes are cosmetic — a `du` failure yields an empty map rather than aborting the clean.
async function directorySizesBytes(dirs: string[]): Promise<Map<string, number>> {
    if (dirs.length === 0) { return new Map(); }
    try {
        const { stdout } = await execFile('/usr/bin/du', ['-sk', ...dirs], { maxBuffer: 4 * 1024 * 1024 });
        const sizes = new Map<string, number>();
        for (const line of stdout.toString().split('\n')) {
            const match = line.match(/^(\d+)\s+(.+)$/);
            if (match) { sizes.set(match[2], Number(match[1]) * 1024); }
        }
        return sizes;
    } catch {
        return new Map();
    }
}

// Bundle ids whose orphan-uninstall prompts were answered "Don't Ask Again".
const DISMISSED_STALE_INSTALL_WARNINGS_KEY = 'dismissedStaleInstallWarnings';

// Watch pbxproj for PRODUCT_BUNDLE_IDENTIFIER renames so we can offer to
// remove the previous install from the selected simulator/device. The
// previous id is remembered in process memory only — pbxproj is the
// source of truth, this is just session-scoped state for detecting the
// "edit happened just now" transition.
let lastKnownPbxBundleId: string | undefined;
let lastRenameNotifiedFor: string | undefined;
async function handlePossibleBundleIdRename(
    log: (message: string) => void,
    workspaceState: vscode.Memento,
    projectRoot: string,
): Promise<boolean> {
    const config = workspaceState.get<BuildTaskConfig>('buildTaskConfig');
    if (!config) { return false; }
    const pbxprojPath = path.join(projectRoot, config.projectFile, 'project.pbxproj');
    const fromPbx = await parseBundleIdFromPbxproj(pbxprojPath, config.targetName, 'Debug');
    if (!fromPbx) { return false; }
    const previous = lastKnownPbxBundleId;
    lastKnownPbxBundleId = fromPbx;
    if (!previous) { return false; }
    if (previous === fromPbx) { return false; }
    // Skip interpolated templates — comparing a raw template to a
    // previously-resolved value would produce false positives.
    if (fromPbx.includes('$(') || previous.includes('$(')) { return false; }
    // macOS has no simulator/device install to uninstall — skip the prompt
    // (and don't consume the rename-notified dedupe key). lastKnownPbxBundleId
    // is already updated above, so detection stays consistent across switches.
    if (getDestinationType(config) === 'mac') { return false; }
    const renameKey = `${previous}→${fromPbx}`;
    if (lastRenameNotifiedFor === renameKey) { return false; }
    lastRenameNotifiedFor = renameKey;
    // What the rename actually left installed is the effective (possibly suffixed) id, not the raw pbxproj value.
    const previousInstalled = effectiveBundleId(previous, config.devBundleId);
    const currentInstalled = effectiveBundleId(fromPbx, config.devBundleId);
    const dismissed = workspaceState.get<string[]>(DISMISSED_STALE_INSTALL_WARNINGS_KEY, []);
    if (dismissed.includes(previousInstalled)) {
        log(`[pbxproj-watcher] rename "${previous}" → "${fromPbx}" detected, but the uninstall warning for ${previousInstalled} was dismissed — skipping prompt`);
        return false;
    }

    log(`[pbxproj-watcher] bundle id rename detected: "${previous}" → "${fromPbx}"`);
    const destination = config.isPhysicalDevice ? 'device' : 'simulator';
    const choice = await vscode.window.showWarningMessage(
        `Bundle id changed: ${previousInstalled} → ${currentInstalled}. The previous install may linger on your ${destination} and appear as a duplicate icon. Uninstall it?`,
        'Uninstall',
        'Keep',
        "Don't Ask Again",
    );
    if (choice === "Don't Ask Again") {
        log(`[pbxproj-watcher] suppressing uninstall warning for ${previousInstalled}`);
        // Re-read: a concurrent prompt may have added its id since the snapshot above.
        const latest = workspaceState.get<string[]>(DISMISSED_STALE_INSTALL_WARNINGS_KEY, []);
        if (!latest.includes(previousInstalled)) {
            await workspaceState.update(DISMISSED_STALE_INSTALL_WARNINGS_KEY, [...latest, previousInstalled]);
        }
        return false;
    }
    if (choice !== 'Uninstall') { return false; }

    // The prompt outlives further edits, so a revert meanwhile could make "previous" the current id again.
    const currentPbx = await parseBundleIdFromPbxproj(pbxprojPath, config.targetName, 'Debug');
    if (currentPbx === previous) {
        log(`[pbxproj-watcher] skipping uninstall — ${previous} is the current bundle id again`);
        return false;
    }

    const cp = await import('child_process');
    let didUninstall = false;
    if (config.simulatorUdid && !config.isPhysicalDevice) {
        log(`[pbxproj-watcher] uninstalling "${previousInstalled}" from simulator ${config.simulatorUdid}`);
        await new Promise<void>((resolve) => {
            cp.exec(`xcrun simctl uninstall "${config.simulatorUdid}" "${previousInstalled}"`, () => resolve());
        });
        didUninstall = true;
    }
    if (config.deviceIdentifier && config.isPhysicalDevice) {
        log(`[pbxproj-watcher] uninstalling "${previousInstalled}" from device ${config.deviceIdentifier}`);
        await new Promise<void>((resolve) => {
            cp.exec(`xcrun devicectl device uninstall app --device "${config.deviceIdentifier}" "${previousInstalled}"`, () => resolve());
        });
        didUninstall = true;
    }
    return didUninstall;
}

// Renaming PRODUCT_BUNDLE_IDENTIFIER leaves the previous install on the
// simulator under the old bundle id while the new build installs under
// the new one — two icons, one running stale code. Detect that twin
// install and offer to remove it.
// An unanswered prompt persists in the notification center, so repeat builds would stack duplicates.
const twinPromptsInFlight = new Set<string>();
async function offerSimulatorTwinUninstall(
    log: (message: string) => void,
    workspaceState: vscode.Memento,
    udid: string,
    appPath: string,
    newBundleId: string,
): Promise<boolean> {
    const newNames = await readInfoPlistDisplayNames(path.join(appPath, 'Info.plist'));
    const productName = newNames.name;
    if (!productName) { return false; }
    const installed = await listInstalledSimulatorApps(udid);
    // The dev/production counterpart is a deliberate side-by-side install, never an orphan.
    const sibling = counterpartBundleId(newBundleId);
    const twin = installed.find((app) =>
        app.bundleId !== newBundleId && app.bundleId !== sibling && app.bundleName === productName
    );
    if (!twin) { return false; }
    const dismissed = workspaceState.get<string[]>(DISMISSED_STALE_INSTALL_WARNINGS_KEY, []);
    if (dismissed.includes(twin.bundleId)) {
        log(`[simulator-debug] product-name twin ${twin.bundleId} present, but its warning was dismissed — skipping prompt`);
        return false;
    }
    if (twinPromptsInFlight.has(twin.bundleId)) { return false; }
    twinPromptsInFlight.add(twin.bundleId);
    try {
        const twinLabel = twin.displayName || twin.bundleName || twin.bundleId;
        log(`[simulator-debug] found product-name twin: "${twinLabel}" (${twin.bundleId})`);
        const choice = await vscode.window.showWarningMessage(
            `Another app with the same product name is installed on the simulator: "${twinLabel}" (${twin.bundleId}). It probably belongs to a previous bundle id and will appear as a duplicate icon. Uninstall it?`,
            'Uninstall',
            'Keep',
            "Don't Ask Again",
        );
        if (choice === 'Uninstall') {
            // The prompt outlives the run, so a revert-and-rebuild meanwhile could make the captured twin id the current app.
            const currentBuiltId = await readInfoPlistBundleId(path.join(appPath, 'Info.plist'));
            if (currentBuiltId === twin.bundleId) {
                log(`[simulator-debug] skipping twin uninstall — ${twin.bundleId} is now the current bundle id`);
                return false;
            }
            log(`[simulator-debug] uninstalling twin ${twin.bundleId}`);
            await uninstallSimulatorApp(udid, twin.bundleId);
            return true;
        }
        if (choice === "Don't Ask Again") {
            log(`[simulator-debug] suppressing twin warning for ${twin.bundleId}`);
            // Re-read: a concurrent prompt for a different twin may have added its id since the snapshot above.
            const latest = workspaceState.get<string[]>(DISMISSED_STALE_INSTALL_WARNINGS_KEY, []);
            if (!latest.includes(twin.bundleId)) {
                await workspaceState.update(DISMISSED_STALE_INSTALL_WARNINGS_KEY, [...latest, twin.bundleId]);
            }
        }
        return false;
    } finally {
        twinPromptsInFlight.delete(twin.bundleId);
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const outputChannel = vscode.window.createOutputChannel('VSXcode');
    const log = (message: string): void => {
        const timestamp = new Date().toLocaleTimeString();
        outputChannel.appendLine(`[${timestamp}] ${message}`);
    };

    // Register sidebar and no-project placeholder
    const sidebarProvider = new SidebarProvider(context.workspaceState, log);
    const treeView = vscode.window.createTreeView('vsxcode.sidebar', {
        treeDataProvider: sidebarProvider,
    });
    let noProjectConfirmed = false;
    const noProjectEmitter = new vscode.EventEmitter<void>();
    vscode.window.registerTreeDataProvider('vsxcode.noProject', {
        onDidChangeTreeData: noProjectEmitter.event,
        getTreeItem: (e: vscode.TreeItem) => e,
        getChildren: () => {
            if (!noProjectConfirmed) { return []; }
            const item = new vscode.TreeItem('No Xcode project found in this workspace.');
            item.iconPath = new vscode.ThemeIcon('info');
            return [item];
        },
    });

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        context.subscriptions.push(treeView, outputChannel);
        return;
    }
    const projectRoot = workspaceFolders[0].uri.fsPath;

    function hasXcodeProject(): boolean {
        try {
            const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
            return entries.some(
                (entry) => entry.isDirectory() && entry.name.endsWith('.xcodeproj')
            );
        } catch {
            return false;
        }
    }

    if (!hasXcodeProject()) {
        noProjectConfirmed = true;
        noProjectEmitter.fire();
        // Watch for .xcodeproj creation, then fully activate
        const xcodeprojWatcher = vscode.workspace.createFileSystemWatcher('**/*.xcodeproj');
        const onXcodeprojCreated = xcodeprojWatcher.onDidCreate(() => {
            xcodeprojWatcher.dispose();
            onXcodeprojCreated.dispose();

            vscode.commands.executeCommand('setContext', 'vsxcode.hasXcodeProject', true);
            setupFullExtension();
        });
        context.subscriptions.push(treeView, outputChannel, xcodeprojWatcher, onXcodeprojCreated);
        return;
    }

    vscode.commands.executeCommand('setContext', 'vsxcode.hasXcodeProject', true);
    setupFullExtension();

    function setupFullExtension(): void {

    // swift-format and Code Quality
    const swiftFormatProvider = new SwiftFormatProvider(context.workspaceState, context.globalState, log);
    const formatterEditProvider = vscode.languages.registerDocumentFormattingEditProvider(
        { language: 'swift', scheme: 'file' },
        swiftFormatProvider,
    );

    const codeQualityProvider = new CodeQualityWebviewProvider(
        context.extensionUri, swiftFormatProvider, context.workspaceState, log,
    );
    const codeQualityViewDisposable = vscode.window.registerWebviewViewProvider('vsxcode.codeFormat', codeQualityProvider);
    context.subscriptions.push(codeQualityViewDisposable, swiftFormatProvider, formatterEditProvider);

    swiftFormatProvider.resolvePathAndVersion().then(async () => {
        await swiftFormatProvider.syncFromConfigFile();
        if (!swiftFormatProvider.isProfileModeExplicit()) {
            if (swiftFormatProvider.hasWorkspaceConfig() || swiftFormatProvider.hasConfigFile()) {
                await swiftFormatProvider.setProfileMode('local');
            } else {
                await swiftFormatProvider.setProfileMode('global');
            }
        }
        codeQualityProvider.refresh();
    }).catch((e) => {
        log(`[swift-format] resolvePathAndVersion failed: ${e}`);
        codeQualityProvider.refresh();
    });

    swiftFormatProvider.onDidSyncConfig(() => codeQualityProvider.refresh());

    // Enable Cmd+R keybinding if build tasks were previously configured
    const existingConfig = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
    if (existingConfig) {
        vscode.commands.executeCommand('setContext', 'vsxcode.buildTasksConfigured', true);
    }

    // Ensure Cmd+R and Cmd+Shift+B bypass terminal input (Kitty protocol in VS Code 1.109+ broke auto-skip)
    const termConfig = vscode.workspace.getConfiguration('terminal.integrated');
    const inspected = termConfig.inspect<string[]>('commandsToSkipShell');
    const userSkipList = inspected?.globalValue || [];
    const cmdsToSkip = ['vsxcode.sidebar.buildAndRun', 'vsxcode.sidebar.build'];
    const missing = cmdsToSkip.filter((cmd) => !userSkipList.includes(cmd));
    if (missing.length > 0) {
        termConfig.update('commandsToSkipShell', [...userSkipList, ...missing], vscode.ConfigurationTarget.Global);
    }

    // Register TaskProvider and DebugConfigurationProvider
    const buildTaskProvider = new XcodeBuildTaskProvider(context.workspaceState);
    const taskProvider = vscode.tasks.registerTaskProvider(TASK_TYPE, buildTaskProvider);
    const debugProvider = vscode.debug.registerDebugConfigurationProvider(
        'lldb-dap',
        new XcodeDebugConfigProvider(context.workspaceState)
    );

    // Register test controller (Testing sidebar integration)
    const testController = new XCTestController(context.workspaceState, projectRoot);

    // Auto-configure on activation, then generate Package.swift for the resolved
    // destination — sequenced so SourceKit-LSP matches the auto-picked device
    // (e.g. cleared to the host SDK for a macOS-only project). Non-blocking.
    void (async () => {
        await autoConfigureBuildTasks(context.workspaceState, sidebarProvider);
        await generatePackageSwift(projectRoot, 'Debug', true, currentDestinationType(context.workspaceState)).catch(() => {});
    })();

    // Seed the rename detector so the very next pbxproj edit can be
    // compared against the current value (otherwise the first watcher
    // fire after activation would just seed without notifying). Guard
    // against the watcher racing this IIFE: if pbxproj is saved during
    // the parse, the watcher handler may set lastKnownPbxBundleId to a
    // newer value first; only seed if still unset to avoid overwriting
    // with a stale snapshot.
    (async () => {
        const current = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!current) { return; }
        const pbxprojPath = path.join(projectRoot, current.projectFile, 'project.pbxproj');
        const seed = await parseBundleIdFromPbxproj(pbxprojPath, current.targetName, 'Debug');
        if (seed && lastKnownPbxBundleId === undefined) { lastKnownPbxBundleId = seed; }
    })();

    // Helper to patch config and refresh sidebar
    async function updateConfig(patch: Partial<BuildTaskConfig>): Promise<void> {
        const current = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!current) { return; }
        await context.workspaceState.update('buildTaskConfig', { ...current, ...patch });
        // Changing project/target/scheme/device invalidates target-keyed
        // data (bundleIdByTarget) and simulator-keyed data
        // (staleSimulatorInstalls), so reload rather than just redraw.
        sidebarProvider.refresh();
    }

    // ── Package.swift commands ────────────────────────────────

    const generateCommand = vscode.commands.registerCommand(
        'vsxcode.createFromXcodeproj',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                await generatePackageSwift(workspaceFolders[0].uri.fsPath, 'Debug', false, currentDestinationType(context.workspaceState));
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    const generateWithOptionsCommand = vscode.commands.registerCommand(
        'vsxcode.createFromXcodeprojWithOptions',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                const config = await vscode.window.showQuickPick(['Debug', 'Release'], {
                    placeHolder: 'Select build configuration for settings extraction'
                });
                if (!config) { return; }
                await generatePackageSwift(workspaceFolders[0].uri.fsPath, config, false, currentDestinationType(context.workspaceState));
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    // ── Manual configure command (fallback) ───────────────────

    const generateBuildTasksCommand = vscode.commands.registerCommand(
        'vsxcode.generateBuildTasks',
        async () => {
            try {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    throw new Error('Open a workspace folder before running this command.');
                }
                await configureBuildTasks(workspaceFolders[0].uri.fsPath, context.workspaceState);
                sidebarProvider.refresh();
            } catch (error) {
                const message = (error as { message?: string }).message as string;
                vscode.window.showErrorMessage(message);
            }
        }
    );

    // ── Sidebar commands ──────────────────────────────────────

    const changeProjectCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeProject',
        async () => {
            const data = sidebarProvider.getProjectData();
            if (!data || data.xcodeProjects.length <= 1) { return; }
            const pick = await vscode.window.showQuickPick(data.xcodeProjects, {
                placeHolder: 'Select Xcode project'
            });
            if (pick) {
                await updateConfig({ projectFile: pick });
                sidebarProvider.refresh();
            }
        }
    );

    const changeTargetCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeTarget',
        async () => {
            const data = sidebarProvider.getProjectData();
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!data || !config) { return; }
            type TargetPick = vscode.QuickPickItem & { targetName: string };
            const picks: TargetPick[] = data.targets.map((t) => ({
                label: t.name,
                description: formatProductType(t.productType),
                targetName: t.name,
            }));
            const activePick = picks.find(p => p.targetName === config.targetName);
            const pick = await new Promise<TargetPick | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick<TargetPick>();
                qp.items = picks;
                qp.placeholder = 'Select target';
                if (activePick) { qp.activeItems = [activePick]; }
                qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.dispose(); });
                qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
                qp.show();
            });
            if (pick) {
                const target = data.targets.find((t) => t.name === pick.targetName)!;
                const rootPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
                const pbxprojPath = path.join(rootPath, config.projectFile, 'project.pbxproj');
                let productName = target.productName || target.name;
                try {
                    const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                    if (target.buildConfigurationListId) {
                        const settings = getBuildSettingsForTarget(
                            pbxContents, target.buildConfigurationListId, 'Debug'
                        );
                        if (settings?.productName && !settings.productName.includes('$(')) {
                            productName = settings.productName;
                        }
                    }
                } catch { /* use existing values */ }
                await updateConfig({ targetName: pick.targetName, productName });
            }
        }
    );

    const changeSchemeCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeScheme',
        async () => {
            const data = sidebarProvider.getProjectData();
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!data || !config || data.schemes.length === 0) { return; }
            const active = data.schemes.find(s => s === config.schemeName);
            const pick = await new Promise<string | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick();
                qp.items = data.schemes.map(s => ({ label: s }));
                qp.placeholder = 'Select scheme';
                if (active) { qp.activeItems = qp.items.filter(i => i.label === active); }
                qp.onDidAccept(() => { resolve(qp.selectedItems[0]?.label); qp.dispose(); });
                qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
                qp.show();
            });
            if (pick) {
                await updateConfig({ schemeName: pick });
            }
        }
    );

    const changeBundleIdCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeBundleId',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const data = sidebarProvider.getProjectData();
            const currentValue = data?.bundleIdByTarget[config.targetName] || '';
            const input = await vscode.window.showInputBox({
                prompt: 'Bundle Identifier',
                value: currentValue,
                placeHolder: 'com.example.MyApp',
            });
            if (input === undefined || input === currentValue) { return; }

            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootPath) { return; }
            const pbxprojPath = path.join(rootPath, config.projectFile, 'project.pbxproj');
            try {
                let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                const target = data?.targets.find(t => t.name === config.targetName);
                if (!target?.buildConfigurationListId) { return; }
                const configIds = resolveConfigurationListId(pbxContents, target.buildConfigurationListId);
                for (const configId of configIds) {
                    pbxContents = updateBuildSetting(pbxContents, configId, 'PRODUCT_BUNDLE_IDENTIFIER', input);
                }
                await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to update PRODUCT_BUNDLE_IDENTIFIER: ${(e as Error).message}`);
            }
        }
    );

    // The suffix hits every target, so an extension's id no longer nests inside its
    // host's — warn once instead of letting it surface as a signing failure.
    const DEV_BUNDLE_ID_EXTENSION_NOTICE_KEY = 'devBundleIdExtensionNoticeShown';
    async function warnIfProjectHasExtensions(): Promise<void> {
        if (context.workspaceState.get<boolean>(DEV_BUNDLE_ID_EXTENSION_NOTICE_KEY)) { return; }
        const targets = sidebarProvider.getProjectData()?.targets || [];
        // watchapp2 is an embedded *application*, not an extension, but carries
        // the same host-prefix requirement.
        const embedded = targets.filter((t) =>
            t.productType.includes('extension') ||
            t.productType.includes('watchkit') ||
            t.productType.includes('watchapp')
        );
        if (embedded.length === 0) { return; }
        await context.workspaceState.update(DEV_BUNDLE_ID_EXTENSION_NOTICE_KEY, true);
        const names = embedded.map((t) => t.name).join(', ');
        vscode.window.showWarningMessage(
            `Dev Bundle ID appends "${DEV_BUNDLE_ID_SUFFIX}" to every target in the scheme, including embedded targets (${names}). Their bundle ids must stay prefixed by the app's, so those targets may fail to build or install.`
        );
    }

    const toggleDevBundleIdCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.toggleDevBundleId',
        async (enabled?: boolean) => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const current = config.devBundleId === true;
            // An explicit argument makes a stale render unable to invert the result; bare invocations flip.
            const next = typeof enabled === 'boolean' ? enabled : !current;
            if (next === current) { return; }
            await context.workspaceState.update('buildTaskConfig', { ...config, devBundleId: next });
            // Redraw, not reload — no cached project data is keyed on this flag.
            sidebarProvider.notifyConfigChanged();
            const base = sidebarProvider.getProjectData()?.bundleIdByTarget[config.targetName];
            const built = base ? effectiveBundleId(base, next) : `(from pbxproj)${next ? DEV_BUNDLE_ID_SUFFIX : ''}`;
            log(`[dev-bundle-id] ${next ? 'enabled' : 'disabled'} — builds install as ${built}`);
            if (next) { await warnIfProjectHasExtensions(); }
        }
    );

    // An inline slot binds an icon to a command, not to a state, so the toggle needs
    // two commands whose `when` clauses select on the row's contextValue.
    const enableDevBundleIdCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.enableDevBundleId',
        () => vscode.commands.executeCommand('vsxcode.sidebar.toggleDevBundleId', true),
    );
    const disableDevBundleIdCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.disableDevBundleId',
        () => vscode.commands.executeCommand('vsxcode.sidebar.toggleDevBundleId', false),
    );

    const uninstallStaleAppsCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.uninstallStaleAppsOnSimulator',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            const data = sidebarProvider.getProjectData();
            if (!config || !data) { return; }
            const stale = data.staleSimulatorInstalls;
            if (stale.length === 0) {
                vscode.window.showInformationMessage('No stale apps detected on the selected simulator.');
                return;
            }
            const summary = stale.map(s => `"${s.displayName || s.bundleName || s.bundleId}" (${s.bundleId})`).join(', ');
            const choice = await vscode.window.showWarningMessage(
                `Uninstall ${stale.length} orphan app(s) from ${config.simulatorDevice}? ${summary}`,
                'Uninstall',
                'Cancel',
            );
            if (choice !== 'Uninstall') { return; }
            const cp = await import('child_process');
            for (const app of stale) {
                log(`[stale-uninstall] uninstalling "${app.bundleId}" from simulator ${config.simulatorUdid}`);
                await new Promise<void>((resolve) => {
                    cp.exec(`xcrun simctl uninstall "${config.simulatorUdid}" "${app.bundleId}"`, () => resolve());
                });
            }
            sidebarProvider.refresh();
        }
    );

    const selectSimulatorCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.selectSimulator',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const [simulators, physicalDevices] = await Promise.all([
                listAvailableSimulators(),
                listPhysicalDevices(),
            ]);
            const macSupported = !!sidebarProvider.getProjectData()?.macSupportByTarget?.[config.targetName];
            const macDest = macSupported ? await getMyMacDestination() : null;
            if (simulators.length === 0 && physicalDevices.length === 0 && !macDest) {
                // An empty list may mean Xcode setup is pending, not truly no devices — offer the fix.
                if (!(await isXcodeFirstLaunchComplete())) {
                    promptXcodeFirstLaunch(true);
                } else {
                    vscode.window.showWarningMessage('No devices found.');
                }
                return;
            }
            type DevicePick = vscode.QuickPickItem & { udid: string; deviceIdentifier: string; destinationType: DestinationType };
            const picks: DevicePick[] = [];
            let activePick: DevicePick | undefined;
            if (macDest) {
                picks.push({ label: 'My Mac', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'mac' });
                const item: DevicePick = {
                    label: 'My Mac',
                    description: `${macDest.name} · ${macDest.arch}`,
                    udid: '',
                    deviceIdentifier: '',
                    destinationType: 'mac',
                };
                if (getDestinationType(config) === 'mac') {
                    activePick = item;
                }
                picks.push(item);
            }
            if (physicalDevices.length > 0) {
                picks.push({ label: 'Physical Devices', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'device' });
                for (const d of physicalDevices) {
                    const transport = d.connectionType === 'wired' ? 'USB' : d.connectionType === 'localNetwork' ? 'Wi-Fi' : d.connectionType;
                    const item: DevicePick = {
                        label: d.name,
                        description: `iOS ${d.osVersion} (${transport})`,
                        udid: d.udid,
                        deviceIdentifier: d.deviceIdentifier,
                        destinationType: 'device',
                    };
                    if (getDestinationType(config) === 'device' && (d.udid === config.simulatorUdid || d.deviceIdentifier === config.deviceIdentifier)) {
                        activePick = item;
                    }
                    picks.push(item);
                }
            }
            if (simulators.length > 0) {
                picks.push({ label: 'Simulators', kind: vscode.QuickPickItemKind.Separator, udid: '', deviceIdentifier: '', destinationType: 'simulator' });
                for (const s of simulators) {
                    const runtime = sidebarProvider.formatRuntime(s.runtime);
                    const booted = s.state === 'Booted' ? ' (Booted)' : '';
                    const item: DevicePick = {
                        label: s.name,
                        description: `${runtime}${booted}`,
                        udid: s.udid,
                        deviceIdentifier: '',
                        destinationType: 'simulator',
                    };
                    if (getDestinationType(config) === 'simulator' && s.udid === config.simulatorUdid) {
                        activePick = item;
                    }
                    picks.push(item);
                }
            }
            sidebarProvider.updatePhysicalDevices(physicalDevices);
            const pick = await new Promise<DevicePick | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick<DevicePick>();
                qp.items = picks;
                qp.placeholder = 'Select device';
                if (activePick) {
                    qp.activeItems = [activePick];
                }
                qp.onDidAccept(() => {
                    resolve(qp.selectedItems[0]);
                    qp.dispose();
                });
                qp.onDidHide(() => {
                    resolve(undefined);
                    qp.dispose();
                });
                qp.show();
                sidebarProvider.notifyConfigChanged();
            });
            if (pick) {
                await updateConfig({
                    simulatorDevice: pick.label,
                    simulatorUdid: pick.udid,
                    deviceIdentifier: pick.deviceIdentifier,
                    isPhysicalDevice: pick.destinationType === 'device',
                    destinationType: pick.destinationType,
                });
                const updated = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
                if (updated) { await reconfigureSourceKitLSP(projectRoot, updated); }
            }
        }
    );

    const changeSwiftVersionCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeSwiftVersion',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const data = sidebarProvider.getProjectData();
            const currentVersion = data?.swiftVersionByTarget[config.targetName] || '';
            const normalizedCurrent = currentVersion.replace(/\.0$/, '');

            const versions = data?.supportedSwiftVersions || [];
            if (versions.length === 0) { return; }
            const picks = versions.map(v => ({ label: `Swift ${v}`, version: v }));
            const active = picks.find(p => p.version === normalizedCurrent);
            const pick = await new Promise<typeof picks[0] | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick<typeof picks[0]>();
                qp.items = picks;
                qp.placeholder = 'Swift Language Version';
                if (active) { qp.activeItems = [active]; }
                qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.dispose(); });
                qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
                qp.show();
            });
            if (!pick || pick.version === normalizedCurrent) { return; }

            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootPath) { return; }
            const pbxprojPath = path.join(rootPath, config.projectFile, 'project.pbxproj');
            try {
                let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                const target = data?.targets.find(t => t.name === config.targetName);
                if (!target?.buildConfigurationListId) { return; }
                const configIds = resolveConfigurationListId(pbxContents, target.buildConfigurationListId);
                for (const configId of configIds) {
                    const pbxValue = pick.version.includes('.') ? pick.version : `${pick.version}.0`;
                    pbxContents = updateBuildSetting(pbxContents, configId, 'SWIFT_VERSION', pbxValue);
                }
                await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to update SWIFT_VERSION: ${(e as Error).message}`);
            }
        }
    );

    const changeStrictConcurrencyCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.changeStrictConcurrency',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) { return; }
            const data = sidebarProvider.getProjectData();
            const currentValue = data?.strictConcurrencyByTarget[config.targetName] || '';

            const options = [
                { label: 'Minimal', value: 'minimal' },
                { label: 'Targeted', value: 'targeted' },
                { label: 'Complete', value: 'complete' },
            ];
            const active = options.find(o => o.value === currentValue);
            const pick = await new Promise<typeof options[0] | undefined>((resolve) => {
                const qp = vscode.window.createQuickPick<typeof options[0]>();
                qp.items = options;
                qp.placeholder = 'Strict Concurrency Checking';
                if (active) { qp.activeItems = [active]; }
                qp.onDidAccept(() => { resolve(qp.selectedItems[0]); qp.dispose(); });
                qp.onDidHide(() => { resolve(undefined); qp.dispose(); });
                qp.show();
            });
            if (!pick || pick.value === currentValue) { return; }

            const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!rootPath) { return; }
            const pbxprojPath = path.join(rootPath, config.projectFile, 'project.pbxproj');
            try {
                let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                const target = data?.targets.find(t => t.name === config.targetName);
                if (!target?.buildConfigurationListId) { return; }
                const configIds = resolveConfigurationListId(pbxContents, target.buildConfigurationListId);
                for (const configId of configIds) {
                    pbxContents = updateBuildSetting(pbxContents, configId, 'SWIFT_STRICT_CONCURRENCY', pick.value);
                }
                await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to update SWIFT_STRICT_CONCURRENCY: ${(e as Error).message}`);
            }
        }
    );

    const buildCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.build',
        async () => {
            await cancelActiveRun();
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            const data = sidebarProvider.getProjectData();
            const target = data?.targets.find(t => t.name === config?.targetName);
            // Test target: build-for-testing (compiles test target without running)
            if (target && isTestTarget(target.productType)) {
                const task = buildTaskProvider.createBuildForTestingTask();
                if (task) {
                    await executeTaskAndWait(task, (exec) => { buildExecution = exec; });
                } else {
                    vscode.window.showErrorMessage('Build task not available. Check configuration.');
                }
                return;
            }
            const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
            const buildTask = tasks.find((t) => t.name === 'Build');
            if (buildTask) {
                await executeTaskAndWait(buildTask, (exec) => { buildExecution = exec; });
            } else {
                vscode.window.showErrorMessage('Build task not available. Check configuration.');
            }
        }
    );

    // ── Debug orchestration ─────────────────────────────────────
    async function buildAndDebugSimulator(config: BuildTaskConfig): Promise<void> {
        // When first-launch is pending, simulator builds fail with a cryptic exit 70
        // ("no device matched the destination") — prompt up front instead.
        if (!(await isXcodeFirstLaunchComplete())) {
            log('[simulator-debug] Xcode first-launch incomplete — simulator build unavailable');
            printToSharedPanel('** Xcode setup incomplete — simulators and devices are unavailable. Finish Xcode setup, then try again. **', '33');
            promptXcodeFirstLaunch();
            return;
        }
        await cancelActiveRun();
        const runId = currentRunId;

        // 1. Fetch and execute build task, wait for completion
        const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
        const buildTask = tasks.find((t) => t.name === 'Build');
        if (!buildTask) {
            vscode.window.showErrorMessage('Build task not available. Check configuration.');
            return;
        }

        // Use shared panel so build output and console share the same terminal
        buildTask.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };

        log('[simulator-debug] starting build...');
        const exitCode = await executeTaskAndWait(buildTask, (exec) => { buildExecution = exec; });
        if (runId !== currentRunId) return;
        if (exitCode !== 0) {
            log(`[simulator-debug] build failed with exit code ${exitCode}`);
            return;
        }
        log('[simulator-debug] build succeeded');

        const udid = config.simulatorUdid || config.simulatorDevice;
        const appPath = builtAppPath(config);

        const resolved = await resolveBundleIdForLaunch({
            appPath,
            pbxprojPath: path.join(projectRoot, config.projectFile, 'project.pbxproj'),
            targetName: config.targetName,
            devBundleId: config.devBundleId,
        });
        if (!resolved) {
            log('[simulator-debug] ERROR: could not resolve bundle id (no Info.plist, no pbxproj)');
            vscode.window.showErrorMessage('Could not resolve bundle id for launch. Check the build output.');
            return;
        }
        const bundleId = resolved.bundleId;
        if (runId !== currentRunId) return;

        // Not awaited so the prompt can't gate install/launch; the orphan's bundle id differs, so removing it can't touch this build.
        offerSimulatorTwinUninstall(log, context.workspaceState, udid, appPath, bundleId)
            .then((didUninstall) => {
                // The post-install refresh usually runs before the prompt resolves, leaving a stale orphan warning behind.
                if (didUninstall) { sidebarProvider.refresh(); }
            })
            .catch((error) => log(`[simulator-debug] twin uninstall check failed: ${error}`));

        // 2. Boot simulator and install app
        const cp = await import('child_process');
        log(`[simulator-debug] installing ${appPath} (bundleId=${bundleId}, source=${resolved.source})`);
        await new Promise<void>((resolve, reject) => {
            cp.exec(
                [
                    `xcrun simctl boot "${udid}" 2>/dev/null || true`,
                    `xcrun simctl terminate "${udid}" "${bundleId}" 2>/dev/null || true`,
                    `xcrun simctl install "${udid}" "${appPath}"`,
                    'open -a Simulator',
                ].join(' && '),
                (error) => error ? reject(error) : resolve()
            );
        });
        if (runId !== currentRunId) return;
        sidebarProvider.refresh();
        const mtimeInfo = await getInstalledAppExecutableMtime(udid, bundleId);
        if (mtimeInfo) {
            log(`[simulator-debug] install succeeded — executable mtime ${formatMtime(mtimeInfo.mtimeMs)} (${path.basename(mtimeInfo.executablePath)})`);
        } else {
            log('[simulator-debug] install succeeded');
        }
        log(`[simulator-debug] launching ${bundleId}`);

        // 3. Start debugger first so it's watching before the app process appears.
        //    --include-existing handles the race where simctl creates the process
        //    before lldb begins polling (same pattern as physical-device flow).
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }

        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName}`,
            stopOnEntry: false,
            attachCommands: [
                `process attach --name ${config.productName} --waitfor --include-existing`,
            ]
        };
        log('[simulator-debug] starting debug session...');
        const debugStarted = vscode.debug.startDebugging(folder, debugConfig);

        // 4. Launch app with console streaming via task (debugger is already watching)
        const allTasks = await vscode.tasks.fetchTasks();
        const launchTask = allTasks.find((t) => t.name === 'Run and Debug');
        if (!launchTask) {
            log('[simulator-debug] ERROR: Run and Debug task not found');
            return;
        }
        log('[simulator-debug] starting console task...');
        consoleExecution = await vscode.tasks.executeTask(launchTask);
        if (runId !== currentRunId) return;

        const started = await debugStarted;
        if (!started) {
            log('[simulator-debug] debug session failed to start');
            buildTaskProvider.writeToConsole('\r\n\x1b[31m** APP LAUNCH FAILED **\x1b[0m\r\n\r\n');
            consoleExecution?.terminate();
            consoleExecution = undefined;
        } else {
            log('[simulator-debug] debug session started');
            buildTaskProvider.writeToConsole('\r\n\x1b[32m** APP LAUNCH SUCCEEDED **\x1b[0m\r\n\r\n');
            activeDebugSession = vscode.debug.activeDebugSession;
        }
    }

    async function buildAndDebugMac(config: BuildTaskConfig): Promise<void> {
        await cancelActiveRun();
        const runId = currentRunId;

        // 1. Fetch and execute build task, wait for completion
        const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
        const buildTask = tasks.find((t) => t.name === 'Build');
        if (!buildTask) {
            vscode.window.showErrorMessage('Build task not available. Check configuration.');
            return;
        }

        // Use shared panel so build output and the launch banner share a terminal
        buildTask.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };

        log('[mac-debug] starting build...');
        const exitCode = await executeTaskAndWait(buildTask, (exec) => { buildExecution = exec; });
        if (runId !== currentRunId) return;
        if (exitCode !== 0) {
            log(`[mac-debug] build failed with exit code ${exitCode}`);
            return;
        }
        log('[mac-debug] build succeeded');

        // 2. Locate the built .app and its executable. macOS bundles keep
        //    Info.plist (and the Mach-O) under Contents/, unlike iOS where
        //    Info.plist sits at the bundle root.
        const appPath = builtAppPath(config);
        const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
        const executableName = (await readInfoPlistExecutable(infoPlist)) || config.productName;
        const program = path.join(appPath, 'Contents', 'MacOS', executableName);

        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }

        // 3. Launch under lldb-dap directly. lldb owns the process lifecycle,
        //    streams stdout/stderr to the Debug Console, and terminates it when
        //    the session ends — no simctl/devicectl, install, or console task.
        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb-dap',
            request: 'launch',
            name: `Debug ${config.productName}`,
            program,
            args: [],
            env: {},
            cwd: folder.uri.fsPath,
            stopOnEntry: false,
        };
        log(`[mac-debug] launching ${program}`);
        const started = await vscode.debug.startDebugging(folder, debugConfig);
        const session = vscode.debug.activeDebugSession;
        if (runId !== currentRunId) {
            // Superseded after launch. Unlike simulator/device there is no
            // console task for cancelActiveRun to terminate, so stop the session
            // we just started here or the app + lldb would leak untracked.
            if (session) { await vscode.debug.stopDebugging(session); }
            return;
        }
        if (!started) {
            log('[mac-debug] debug session failed to start');
            printToSharedPanel('** APP LAUNCH FAILED **', '31');
        } else {
            log('[mac-debug] debug session started');
            printToSharedPanel('** APP LAUNCH SUCCEEDED **', '32');
            activeDebugSession = session;
        }
    }

    async function buildAndDebugPhysicalDevice(config: BuildTaskConfig): Promise<void> {
        await cancelActiveRun();
        const runId = currentRunId;

        // 1. Fetch and execute build task, wait for completion
        const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
        const buildTask = tasks.find((t) => t.name === 'Build');
        if (!buildTask) {
            vscode.window.showErrorMessage('Build task not available. Check configuration.');
            return;
        }

        // Use shared panel so build output and console share the same terminal
        buildTask.presentationOptions = {
            reveal: vscode.TaskRevealKind.Always,
            panel: vscode.TaskPanelKind.Shared,
            showReuseMessage: false,
            clear: true,
        };

        log('[physical-debug] starting build...');
        const exitCode = await executeTaskAndWait(buildTask, (exec) => { buildExecution = exec; });
        if (runId !== currentRunId) return;
        if (exitCode !== 0) {
            log(`[physical-debug] build failed with exit code ${exitCode}`);
            vscode.window.showErrorMessage('Build failed. Make sure your device is connected and unlocked, then try again.');
            return;
        }
        log('[physical-debug] build succeeded');

        const devId = config.deviceIdentifier || config.simulatorUdid || config.simulatorDevice;
        const appPath = builtAppPath(config);

        const resolved = await resolveBundleIdForLaunch({
            appPath,
            pbxprojPath: path.join(projectRoot, config.projectFile, 'project.pbxproj'),
            targetName: config.targetName,
            devBundleId: config.devBundleId,
        });
        if (!resolved) {
            log('[physical-debug] ERROR: could not resolve bundle id (no Info.plist, no pbxproj)');
            vscode.window.showErrorMessage('Could not resolve bundle id for launch. Check the build output.');
            return;
        }

        // 2. Install app on device
        try {
            log(`[physical-debug] installing ${appPath} (bundleId=${resolved.bundleId}, source=${resolved.source}) on device...`);
            await devicectlInstall(devId, appPath);
            if (runId !== currentRunId) return;
            log('[physical-debug] install succeeded');
        } catch (error) {
            if (runId !== currentRunId) return;
            const message = (error as { message?: string }).message || String(error);
            log(`[physical-debug] install failed: ${message}`);
            vscode.window.showErrorMessage('Failed to install app. Make sure your device is connected and unlocked, then try again.');
            return;
        }

        // 3. Verify device is unlocked before launching
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            vscode.window.showErrorMessage('No workspace folder found.');
            return;
        }

        log('[physical-debug] checking device readiness...');
        const initialCheck = await checkDeviceReady(devId);
        if (runId !== currentRunId) return;
        if (!initialCheck.ready) {
            log(`[physical-debug] device not ready: ${initialCheck.message}`);
            const unlocked = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Device is locked. Waiting for unlock…',
                    cancellable: true,
                },
                async (_progress, token) => {
                    while (!token.isCancellationRequested && runId === currentRunId) {
                        await new Promise<void>((resolve) => {
                            const timeout = setTimeout(resolve, 3000);
                            token.onCancellationRequested(() => { clearTimeout(timeout); resolve(); });
                        });
                        if (token.isCancellationRequested || runId !== currentRunId) return false;
                        const check = await checkDeviceReady(devId);
                        if (check.ready) return true;
                    }
                    return false;
                }
            );
            if (runId !== currentRunId) return;
            if (!unlocked) {
                log('[physical-debug] cancelled waiting for device unlock');
                printToSharedPanel('** APP LAUNCH CANCELLED **');
                return;
            }
            log('[physical-debug] device unlocked');
        }

        // 4. Launch app with console streaming via task
        const debugConsoleTask = buildTaskProvider.createPhysicalDebugTask(config, folder);
        log('[physical-debug] starting debug console task...');
        consoleExecution = await vscode.tasks.executeTask(debugConsoleTask);
        if (runId !== currentRunId) return;

        // 5. Wait for console task to settle — detect early failures (locked device, etc.)
        const earlyExit = await Promise.race<number | null>([
            new Promise<number>((resolve) => {
                const listener = vscode.tasks.onDidEndTaskProcess((event) => {
                    if (event.execution.task.name === 'Run and Debug') {
                        listener.dispose();
                        resolve(event.exitCode ?? 1);
                    }
                });
                setTimeout(() => listener.dispose(), 3500);
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
        ]);

        if (runId !== currentRunId) return;
        if (earlyExit !== null) {
            log(`[physical-debug] console task exited early with code ${earlyExit}`);
            consoleExecution = undefined;
            buildTaskProvider.writeToConsole('\r\n\x1b[33m** APP LAUNCH EXITED **\x1b[0m\r\n\r\n');
            return;
        }
        log('[physical-debug] console task is running');
        buildTaskProvider.writeToConsole('\r\n\x1b[32m** APP LAUNCH SUCCEEDED **\x1b[0m\r\n\r\n');

        // 6. Check for cached device symbols (Xcode's iOS DeviceSupport)
        const physicalDevice = sidebarProvider.getProjectData()?.physicalDevices.find(
            d => d.udid === config.simulatorUdid || d.deviceIdentifier === config.deviceIdentifier
        );
        let symbolsPath: string | undefined;
        if (physicalDevice) {
            symbolsPath = await findDeviceSymbols(physicalDevice);
            if (!symbolsPath) {
                log(`[physical-debug] no cached symbols for ${physicalDevice.productType} ${physicalDevice.osVersion} (${physicalDevice.osBuildVersion})`);
                vscode.window.showWarningMessage(
                    `No cached device symbols for iOS ${physicalDevice.osVersion}. Debugging will be slower. Open Xcode with this device connected to download symbols.`,
                    'Open Xcode'
                ).then((action) => {
                    if (action === 'Open Xcode') {
                        execFile('open', ['-a', 'Xcode'], { encoding: 'utf8' }).catch(() => {});
                    }
                });
            } else {
                log(`[physical-debug] found cached symbols at ${symbolsPath}`);
            }
        }

        // 7. Attach debugger by name (--waitfor finds the --start-stopped process)
        const initCommands = [
            'platform select remote-ios',
        ];
        if (symbolsPath) {
            initCommands.push(`settings append target.exec-search-paths "${symbolsPath}"`);
        }
        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb-dap',
            request: 'attach',
            name: `Debug ${config.productName} (Device)`,
            program: appPath,
            stopOnEntry: false,
            initCommands,
            attachCommands: [
                `device select ${devId}`,
                `device process attach --name ${config.productName} --waitfor --include-existing`,
            ],
        };
        log('[physical-debug] starting debug session...');
        const started = await vscode.debug.startDebugging(folder, debugConfig);
        if (!started) {
            log('[physical-debug] debug session failed to start');
            buildTaskProvider.writeToConsole('\r\n\x1b[33m** APP LAUNCH CANCELLED **\x1b[0m\r\n\r\n');
            consoleExecution?.terminate();
            consoleExecution = undefined;
        } else {
            activeDebugSession = vscode.debug.activeDebugSession;
        }
    }

    const buildAndRunCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.buildAndRun',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            if (!config) {
                vscode.window.showErrorMessage(
                    'No build configuration found. Run "Swift: Configure Build Tasks" first.',
                    'Configure'
                ).then((action) => {
                    if (action === 'Configure') {
                        vscode.commands.executeCommand('vsxcode.generateBuildTasks');
                    }
                });
                return;
            }
            // Test target: run tests instead of build-install-run
            const data = sidebarProvider.getProjectData();
            const target = data?.targets.find(t => t.name === config.targetName);
            if (target && isTestTarget(target.productType)) {
                await cancelActiveRun();
                const tasks = await vscode.tasks.fetchTasks({ type: TASK_TYPE });
                const testTask = tasks.find((t) => t.name === 'Test');
                if (testTask) {
                    await executeTaskAndWait(testTask, (exec) => { buildExecution = exec; });
                } else {
                    vscode.window.showErrorMessage('Test task not available. Check configuration.');
                }
                return;
            }
            switch (getDestinationType(config)) {
                case 'device':
                    await buildAndDebugPhysicalDevice(config);
                    break;
                case 'mac':
                    await buildAndDebugMac(config);
                    break;
                case 'simulator':
                    await buildAndDebugSimulator(config);
                    break;
            }
        }
    );

    const refreshCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.refresh',
        async () => {
            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            await sidebarProvider.loadProjectData(config);
            sidebarProvider.refresh();
        }
    );

    const cleanDerivedDataCmd = vscode.commands.registerCommand(
        'vsxcode.sidebar.cleanDerivedData',
        async () => {
            // Deleting the tree under a live build/test/debug run would fail it mid-write.
            const buildOrRunActive = (): boolean =>
                vscode.tasks.taskExecutions.some((exec) => exec.task.definition.type === TASK_TYPE)
                || vscode.debug.activeDebugSession !== undefined
                || testController.isBusy;
            const warnBusy = (): void => {
                vscode.window.showWarningMessage(
                    'Cannot clean DerivedData while a build, test run, or debug session is active. Stop it and try again.'
                );
            };
            if (buildOrRunActive()) {
                warnBusy();
                return;
            }

            const base = derivedDataBasePath();
            let schemeDirs: string[] = [];
            try {
                schemeDirs = (await fsp.readdir(base, { withFileTypes: true }))
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name);
            } catch { /* base doesn't exist yet */ }
            if (schemeDirs.length === 0) {
                vscode.window.showInformationMessage('VSXcode DerivedData is already clean.');
                return;
            }

            const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
            const currentScheme = config && schemeDirs.includes(config.schemeName)
                ? config.schemeName
                : undefined;

            const sizes = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: 'Measuring DerivedData…' },
                () => directorySizesBytes(schemeDirs.map((dir) => path.join(base, dir)))
            );
            const totalBytes = [...sizes.values()].reduce((sum, b) => sum + b, 0);

            type CleanPick = vscode.QuickPickItem & { schemes: string[]; bytes: number | undefined; noun: string };
            const picks: CleanPick[] = [];
            if (currentScheme) {
                const bytes = sizes.get(path.join(base, currentScheme));
                picks.push({
                    label: `Clean "${currentScheme}"`,
                    description: bytes === undefined ? undefined : formatBytes(bytes),
                    detail: path.join(base, currentScheme),
                    schemes: [currentScheme],
                    bytes,
                    noun: `scheme "${currentScheme}"`,
                });
            }
            if (schemeDirs.length > 1 || !currentScheme) {
                picks.push({
                    label: `Clean All Schemes (${schemeDirs.length})`,
                    description: sizes.size === 0 ? undefined : formatBytes(totalBytes),
                    detail: base,
                    schemes: schemeDirs,
                    bytes: sizes.size === 0 ? undefined : totalBytes,
                    noun: schemeDirs.length === 1 ? `scheme "${schemeDirs[0]}"` : `all ${schemeDirs.length} schemes`,
                });
            }
            const pick = picks.length === 1
                ? picks[0]
                : await vscode.window.showQuickPick(picks, { placeHolder: 'Clean DerivedData for…' });
            if (!pick) { return; }

            const sizeNote = pick.bytes === undefined ? '' : ` This frees ${formatBytes(pick.bytes)}.`;
            const confirmed = await vscode.window.showWarningMessage(
                `Delete DerivedData for ${pick.noun}?${sizeNote} The next build will start from scratch.`,
                { modal: true },
                'Delete'
            );
            if (confirmed !== 'Delete') { return; }

            // Re-check: a build or test run can start while the prompts are up.
            if (buildOrRunActive()) {
                warnBusy();
                return;
            }

            try {
                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'Cleaning DerivedData…' },
                    async () => {
                        for (const scheme of pick.schemes) {
                            await fsp.rm(path.join(base, scheme), { recursive: true, force: true });
                        }
                    }
                );
            } catch (error) {
                const message = (error as { message?: string }).message || String(error);
                vscode.window.showErrorMessage(`VSXcode: failed to clean DerivedData — ${message}`);
                return;
            }
            log(`[clean-derived-data] removed ${pick.schemes.length} scheme tree(s) under ${base}`);
            const freed = pick.bytes === undefined ? '' : ` — freed ${formatBytes(pick.bytes)}`;
            vscode.window.showInformationMessage(`Cleaned DerivedData for ${pick.noun}${freed}.`);
        }
    );

    // ── File watcher ──────────────────────────────────────────

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.pbxproj');
    const onProjectChange = watcher.onDidChange(async () => {
        sidebarProvider.refresh();
        testController.refresh();
        const wsFolders = vscode.workspace.workspaceFolders;
        if (wsFolders && wsFolders.length > 0) {
            generatePackageSwift(wsFolders[0].uri.fsPath, 'Debug', true, currentDestinationType(context.workspaceState)).catch((error) => {
                const message = (error as { message?: string }).message || String(error);
                log(`[file-watcher] Package.swift regen failed: ${message}`);
            });
        }
        // Not awaited: the prompt can sit unanswered indefinitely.
        handlePossibleBundleIdRename(log, context.workspaceState, projectRoot)
            .then((didUninstall) => { if (didUninstall) { sidebarProvider.refresh(); } })
            .catch((error) => log(`[pbxproj-watcher] rename check failed: ${error}`));
    });

    // ── Swift file watcher (auto-sync to pbxproj) ─────────────

    const swiftWatcherDisposables = createSwiftFileWatcher(projectRoot, log);
    context.subscriptions.push(...swiftWatcherDisposables);

    // Catch-up scan for Swift files added while the watcher wasn't live (VS Code closed, git checkout, external tooling).
    reconcileSwiftFiles(projectRoot, log)
        .then((added) => {
            if (added > 0) {
                vscode.window.showInformationMessage(`VSXcode: added ${added} Swift file(s) to the Xcode project.`);
            }
        })
        .catch((error) => {
            const message = (error as { message?: string }).message || String(error);
            log(`[swift-sync] reconcile failed: ${message}`);
        });

    const syncProjectFilesCmd = vscode.commands.registerCommand('vsxcode.syncProjectFiles', async () => {
        try {
            const added = await reconcileSwiftFiles(projectRoot, log);
            vscode.window.showInformationMessage(
                added > 0
                    ? `VSXcode: added ${added} Swift file(s) to the Xcode project.`
                    : 'VSXcode: all Swift files are already in sync.'
            );
        } catch (error) {
            const message = (error as { message?: string }).message || String(error);
            vscode.window.showErrorMessage(`VSXcode: sync failed — ${message}`);
        }
    });
    context.subscriptions.push(syncProjectFilesCmd);

    // ── Auto-continue past debugger-internal stops ──────────────
    //
    // Physical-device launches with --start-stopped generate several stops
    // that must be silently continued:
    //
    // 1. Initial attach stop (reason=none) — lldb-dap reports a stop with
    //    no reason during attach. Usually handled internally via
    //    configurationDone, but can leak through afterward.
    //
    // 2. SIGSTOP from --start-stopped (reason=exception,
    //    description="signal SIGSTOP") — delivered during early dyld
    //    execution (lldb_image_notifier / start).
    //
    // 3. Internal breakpoint stops (negative IDs in LLDB). This is a
    //    lldb-dap bug (fixed in LLVM PR #173848, not yet in Xcode).
    //
    // Gate: auto-continue only fires AFTER the `configurationDone` response
    // is sent by the adapter. Stops arriving before that are part of
    // lldb-dap's launch sequence — resuming them there races the adapter's
    // state machine and triggers "Expected process to be stopped" errors
    // (observed on USB, where low latency causes `stopped` events to
    // arrive before configurationDone; Wi-Fi latency usually hides it).
    //
    // Post-configurationDone classification:
    //   • SIGSTOP exception  → continue (debugger artifact)
    //   • All-negative bp IDs → continue (internal breakpoint)
    //   • No IDs / no reason → continue (leaked initial attach)

    const dyldTracker = vscode.debug.registerDebugAdapterTrackerFactory('lldb-dap', {
        createDebugAdapterTracker(session) {
            // macOS uses request:'launch' with stopOnEntry:false and has none of
            // the --start-stopped/attach artifacts this tracker exists to skip.
            // Scope it to attach sessions so it can never auto-continue a real
            // launch stop.
            if (session.configuration.request === 'launch') {
                return undefined;
            }
            let configDoneAck = false;
            return {
                onDidSendMessage(message: any) {
                    // Unlock auto-continue once lldb-dap confirms configurationDone.
                    if (message.type === 'response' && message.command === 'configurationDone' && message.success) {
                        configDoneAck = true;
                        return;
                    }

                    if (message.type !== 'event' || message.event !== 'stopped') return;

                    // Pre-launch stops are owned by lldb-dap. Leave them alone.
                    if (!configDoneAck) return;

                    const body = message.body || {};
                    const ids: number[] = body.hitBreakpointIds ?? [];
                    const desc: string = body.description ?? '';

                    // SIGSTOP from --start-stopped is a debugger artifact, not a crash.
                    if (body.reason === 'exception' && desc.startsWith('signal SIGSTOP')) {
                        log('[debug-tracker] auto-continuing past SIGSTOP');
                        Promise.resolve(session.customRequest('continue', {
                            threadId: body.threadId ?? 1,
                        })).catch(() => {});
                        return;
                    }

                    // Real exceptions (EXC_BAD_ACCESS, SIGABRT, etc.) — never swallow
                    if (body.reason === 'exception') return;

                    // Internal breakpoints have negative IDs in LLDB
                    // (LLDB_BREAK_ID_IS_INTERNAL(bid) = bid < 0).
                    // If ANY hitBreakpointIds is >= 0, a user breakpoint was hit.
                    if (ids.length > 0 && ids.some((id) => id >= 0)) return;

                    // Stops with all-negative IDs are internal (dyld) — resume.
                    if (ids.length > 0) {
                        log('[debug-tracker] auto-continuing past internal breakpoint');
                        Promise.resolve(session.customRequest('continue', {
                            threadId: body.threadId ?? 1,
                        })).catch(() => {});
                        return;
                    }

                    // Leaked initial-attach stop after configurationDone.
                    log('[debug-tracker] auto-continuing past initial attach stop');
                    Promise.resolve(session.customRequest('continue', {
                        threadId: body.threadId ?? 1,
                    })).catch(() => {});
                },
            };
        },
    });

    // ── Debug cleanup ──────────────────────────────────────────

    const onDebugEnd = vscode.debug.onDidTerminateDebugSession(async (session) => {
        if (session !== activeDebugSession) return;
        activeDebugSession = undefined;

        // Physical device: killing the console process (devicectl --console) terminates the app.
        // Next launch uses --terminate-existing as a safety net.
        const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        const dest = config ? getDestinationType(config) : 'simulator';

        // macOS: lldb-dap owns the launched process; ending the session already
        // terminated it. There is no console task or simctl app to clean up.
        if (dest === 'mac') {
            log('[debug-end] mac launch session ended');
            return;
        }

        // Simulator: terminate the app first, then kill the console process.
        // simctl terminate tells the simulator runtime to stop the app (which is
        // a separate process not in our group), then killConsoleProcess ends the
        // monitoring process (simctl launch --console-pty) and completes the task.
        if (config && dest === 'simulator') {
            const appPath = builtAppPath(config);
            const resolved = await resolveBundleIdForLaunch({
                appPath,
                pbxprojPath: path.join(projectRoot, config.projectFile, 'project.pbxproj'),
                targetName: config.targetName,
                devBundleId: config.devBundleId,
            });
            if (resolved) {
                const cp = await import('child_process');
                const udid = config.simulatorUdid || config.simulatorDevice;
                log(`[debug-end] terminating app "${resolved.bundleId}" on simulator`);
                await new Promise<void>((resolve) => {
                    cp.exec(
                        `xcrun simctl terminate "${udid}" "${resolved.bundleId}"`,
                        () => resolve()
                    );
                });
            }
        }

        log('[debug-end] killing console process');
        buildTaskProvider.killConsoleProcess();
    });

    const onDebugStart = vscode.debug.onDidStartDebugSession((session) => {
        const config = context.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        const target = config ? getDestinationType(config) : 'simulator';
        log(`[run-and-debug] ${session.name} — debugger active on ${target}`);
    });

    // ── Register all disposables ──────────────────────────────

    context.subscriptions.push(
        generateCommand, generateWithOptionsCommand, generateBuildTasksCommand,
        taskProvider, debugProvider, treeView, testController,
        changeProjectCmd, changeTargetCmd, changeSchemeCmd, changeBundleIdCmd,
        toggleDevBundleIdCmd, enableDevBundleIdCmd, disableDevBundleIdCmd, uninstallStaleAppsCmd,
        selectSimulatorCmd, changeSwiftVersionCmd, changeStrictConcurrencyCmd, buildCmd, buildAndRunCmd, refreshCmd,
        cleanDerivedDataCmd,
        watcher, onProjectChange, dyldTracker, onDebugStart, onDebugEnd,
        outputChannel
    );

    // One-time migration notice for users with old file-based build tasks
    const oldScriptsExist = fs.existsSync(path.join(projectRoot, '.vscode', 'scripts', 'build.sh'));
    const noticeShown = context.workspaceState.get<boolean>('migrationNoticeShown');
    if (oldScriptsExist && !noticeShown) {
        vscode.window.showInformationMessage(
            'VSXcode now uses integrated build tasks. You can safely delete .vscode/scripts/ and the build entries in tasks.json/launch.json.'
        );
        context.workspaceState.update('migrationNoticeShown', true);
    }

    } // end setupFullExtension
}

export function deactivate(): void {
    if (consoleExecution) {
        consoleExecution.terminate();
        consoleExecution = undefined;
    }
    if (buildExecution) {
        buildExecution.terminate();
        buildExecution = undefined;
    }
}
