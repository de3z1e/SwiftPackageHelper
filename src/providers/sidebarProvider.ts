import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { BuildTaskConfig, NativeTarget } from '../types/interfaces';
import { listAvailableSimulators, listPhysicalDevices, type SimulatorDevice, type PhysicalDevice } from '../utils/simulator';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { getBuildSettingsForTarget, getProjectBuildSettings, platformsSupported } from '../parsers/buildSettings';
import { getDestinationType } from '../utils/destination';
import { detectSupportedSwiftVersions, isXcodeFirstLaunchComplete } from '../utils/version';
import { listInstalledSimulatorApps, effectiveBundleId, DEV_BUNDLE_ID_SUFFIX, type InstalledAppSummary } from '../utils/bundleId';

const execFile = promisify(execFileCallback);

let firstLaunchPrompted = false;

export function promptXcodeFirstLaunch(force = false): void {
    // Show once per session (avoids activation spam) unless an explicit action forces it.
    if (firstLaunchPrompted && !force) { return; }
    firstLaunchPrompted = true;
    vscode.window.showWarningMessage(
        'Xcode needs to finish setting up after an update — simulators and devices are unavailable until then.',
        'Open Xcode',
        'Run Setup'
    ).then((selection) => {
        if (selection === 'Open Xcode') {
            // Launching Xcode.app triggers its component-install flow, completing first launch.
            execFile('open', ['-a', 'Xcode']).catch(() => {});
            return;
        }
        if (selection !== 'Run Setup') { return; }
        const terminal = vscode.window.createTerminal('Xcode Setup');
        terminal.show();
        // runFirstLaunch needs root to install the updated components; the terminal prompts for it.
        const send = () => terminal.sendText('sudo xcodebuild -runFirstLaunch');
        const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
            if (e.terminal === terminal) {
                send();
                listener.dispose();
                clearTimeout(fallbackTimer);
            }
        });
        const closeListener = vscode.window.onDidCloseTerminal((t) => {
            if (t === terminal) { listener.dispose(); closeListener.dispose(); clearTimeout(fallbackTimer); }
        });
        const fallbackTimer = setTimeout(() => { listener.dispose(); send(); }, 3000);
    });
}

let readinessWatch: ReturnType<typeof setInterval> | undefined;

/**
 * Poll readiness in the background while first-launch is incomplete and refresh
 * the sidebar the instant setup completes, so no manual reload is needed.
 */
function startXcodeReadinessWatch(): void {
    if (readinessWatch) { return; }
    let elapsedMs = 0;
    const timer = setInterval(async () => {
        elapsedMs += 10000;
        let ready = false;
        try { ready = await isXcodeFirstLaunchComplete(); } catch { /* keep polling */ }
        if (ready) {
            clearInterval(timer);
            readinessWatch = undefined;
            firstLaunchPrompted = false; // re-arm the prompt if Xcode breaks again later
            vscode.window.showInformationMessage('Xcode is ready — simulators and devices are available.');
            vscode.commands.executeCommand('vsxcode.sidebar.refresh');
        } else if (elapsedMs >= 30 * 60 * 1000) {
            clearInterval(timer);
            readinessWatch = undefined;
        }
    }, 10000);
    readinessWatch = timer;
}

// ── Tree item types ──────────────────────────────────────────────

type SidebarItemType =
    | 'section-config'
    | 'config-project'
    | 'config-target'
    | 'config-scheme'
    | 'config-bundleId'
    | 'config-simulator'
    | 'config-swiftVersion'
    | 'config-strictConcurrency';

export class SidebarItem extends vscode.TreeItem {
    constructor(
        public readonly itemType: SidebarItemType,
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemValue?: string
    ) {
        super(label, collapsibleState);
    }
}

// ── Cached project data ──────────────────────────────────────────

export interface ProjectData {
    xcodeProjects: string[];
    targets: NativeTarget[];
    schemes: string[];
    simulators: SimulatorDevice[];
    physicalDevices: PhysicalDevice[];
    swiftVersionByTarget: Record<string, string>;
    strictConcurrencyByTarget: Record<string, string>;
    bundleIdByTarget: Record<string, string>;
    productNameByTarget: Record<string, string>;
    macSupportByTarget: Record<string, boolean>;
    // False when Xcode's first-launch setup is incomplete — simulators/devices unavailable.
    xcodeReady: boolean;
    supportedSwiftVersions: string[];
    /** Apps installed on the currently-selected simulator whose CFBundleName
     *  matches the project's product name but whose bundle id is neither the
     *  pbxproj value nor its dev counterpart — usually orphans from a rename. */
    staleSimulatorInstalls: InstalledAppSummary[];
}

// ── TreeDataProvider ─────────────────────────────────────────────

export class SidebarProvider implements vscode.TreeDataProvider<SidebarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SidebarItem | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private projectData: ProjectData | null = null;

    constructor(
        private workspaceState: vscode.Memento,
        private readonly log: (message: string) => void = () => {}
    ) {}

    refresh(): void {
        this.projectData = null;
        this._onDidChangeTreeData.fire();
    }

    notifyConfigChanged(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SidebarItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SidebarItem): Promise<SidebarItem[]> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');

        if (!element) {
            if (!config) {
                return [];
            }
            return [
                this.createSectionItem('section-config', 'Configuration', 'gear'),
            ];
        }

        if (!this.projectData) {
            await this.loadProjectData(config);
        }

        if (element.itemType === 'section-config') {
            return this.getConfigItems(config!);
        }

        return [];
    }

    // ── Section builders ──────────────────────────────────────

    private createSectionItem(
        type: 'section-config',
        label: string,
        iconId: string
    ): SidebarItem {
        const item = new SidebarItem(type, label, vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(iconId);
        return item;
    }

    private getConfigItems(config: BuildTaskConfig): SidebarItem[] {
        const items = [
            this.createConfigItem('config-project', 'Project', config.projectFile,
                'vsxcode.sidebar.changeProject', 'project'),
            this.createConfigItem('config-target', 'Target', config.targetName,
                'vsxcode.sidebar.changeTarget', 'vsxcode-target'),
            this.createConfigItem('config-scheme', 'Scheme', config.schemeName,
                'vsxcode.sidebar.changeScheme', 'play-circle'),
            this.createBundleIdItem(config),
            this.createConfigItem('config-swiftVersion', 'Swift Language Version',
                this.projectData?.swiftVersionByTarget[config.targetName] ? `Swift ${this.projectData.swiftVersionByTarget[config.targetName].replace(/\.0$/, '')}` : '',
                'vsxcode.sidebar.changeSwiftVersion', 'vsxcode-swift'),
        ];
        const concurrency = this.formatStrictConcurrency(config.targetName);
        if (concurrency) {
            items.push(this.createConfigItem('config-strictConcurrency', 'Strict Concurrency Checking',
                concurrency, 'vsxcode.sidebar.changeStrictConcurrency', 'shield'));
        }
        const deviceLabel = this.formatDeviceLabel(config);
        items.push(this.createConfigItem('config-simulator', 'Device', deviceLabel,
            'vsxcode.sidebar.selectSimulator', 'device-mobile'));
        return items;
    }

    // The row shows what a build produces, not what pbxproj stores — those differ
    // while Dev Bundle ID is on, which is an override and never edits pbxproj.
    // The warning state is for *external* drift: an old app installed on the
    // simulator with the same product name but a different bundle id — usually
    // an orphan from a previous rename.
    private createBundleIdItem(config: BuildTaskConfig): SidebarItem {
        const fromPbx = this.projectData?.bundleIdByTarget[config.targetName] || '';
        const stale = this.projectData?.staleSimulatorInstalls || [];
        const hasStaleInstall = stale.length > 0;
        const devEnabled = config.devBundleId === true;
        const builtId = effectiveBundleId(fromPbx, devEnabled);
        const devLabel = devEnabled ? 'Dev: On' : 'Dev: Off';
        const devTooltip = devEnabled
            ? `\n\nDev Bundle ID is on: builds append "${DEV_BUNDLE_ID_SUFFIX}"${fromPbx ? ` and install as ${builtId}` : ''}, so the development app sits alongside the shipping one. project.pbxproj keeps ${fromPbx || 'its own value'}. Use the ✓ button on this row to turn it off.`
            : `\n\nDev Bundle ID is off: builds use the bundle id exactly as committed. Use the ○ button on this row to build as ${fromPbx ? effectiveBundleId(fromPbx, true) : `…${DEV_BUNDLE_ID_SUFFIX}`} instead, so a development build installs alongside the shipping app.`;
        // Encoded into contextValue so package.json can pick which half of the toggle pair to render.
        const devContext = devEnabled ? 'devOn' : 'devOff';

        const item = new SidebarItem('config-bundleId', 'Bundle ID', vscode.TreeItemCollapsibleState.None, builtId);
        item.description = fromPbx ? `${builtId} · ${devLabel}` : devLabel;
        // Clicking always edits — neither the warning state nor the toggle may hijack that.
        item.command = { command: 'vsxcode.sidebar.changeBundleId', title: 'Bundle ID' };
        if (hasStaleInstall) {
            const ids = stale.map((s) => s.bundleId).join(', ');
            item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
            item.tooltip = `An orphan install with a different bundle id is on the selected simulator: ${ids}. It probably belongs to a previous bundle id and will appear as a duplicate icon. Click to edit the bundle id; use the trash icon to uninstall the orphan(s).${devTooltip}`;
            item.contextValue = `config-bundleId-stale-${devContext}`;
        } else {
            item.iconPath = new vscode.ThemeIcon('tag');
            item.tooltip = `Bundle id from project.pbxproj (the source of truth). Click to edit PRODUCT_BUNDLE_IDENTIFIER.${devTooltip}`;
            item.contextValue = `config-bundleId-${devContext}`;
        }
        return item;
    }

    private createConfigItem(
        type: SidebarItemType,
        label: string,
        value: string,
        commandId: string,
        iconId: string
    ): SidebarItem {
        const item = new SidebarItem(type, label, vscode.TreeItemCollapsibleState.None, value);
        item.description = value;
        item.iconPath = new vscode.ThemeIcon(iconId);
        item.command = { command: commandId, title: label };
        return item;
    }

    private formatStrictConcurrency(targetName: string): string {
        const value = this.projectData?.strictConcurrencyByTarget[targetName];
        if (!value) { return ''; }
        return value.charAt(0).toUpperCase() + value.slice(1);
    }

    private formatDeviceLabel(config: BuildTaskConfig): string {
        if (!config.simulatorDevice) { return ''; }
        const dest = getDestinationType(config);
        if (dest === 'mac') {
            return 'My Mac';
        }
        // Simulators/devices are down until first-launch completes — flag the stale selection.
        const unavailable = this.projectData?.xcodeReady === false ? ' — unavailable' : '';
        if (dest === 'simulator') {
            const sim = this.projectData?.simulators.find((s) => s.udid === config.simulatorUdid);
            let version = '';
            if (sim) {
                const formatted = this.formatRuntime(sim.runtime);
                // formatRuntime returns the raw identifier when it can't parse — don't surface that.
                if (formatted !== sim.runtime) { version = `${formatted} `; }
            }
            return `${config.simulatorDevice} (${version}Simulator)${unavailable}`;
        }
        const physical = this.projectData?.physicalDevices.find(
            d => d.udid === config.simulatorUdid || d.deviceIdentifier === config.deviceIdentifier
        );
        const connectionType = physical?.connectionType;
        const transport = connectionType === 'wired' ? 'USB' : connectionType === 'localNetwork' ? 'Wi-Fi' : connectionType || 'Unknown';
        const version = physical?.osVersion ? `iOS ${physical.osVersion}, ` : '';
        return `${config.simulatorDevice} (${version}${transport})${unavailable}`;
    }

    // ── Data loading ──────────────────────────────────────────

    async loadProjectData(config?: BuildTaskConfig | null): Promise<void> {
        const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!rootPath) { return; }

        this.log('[sidebar] loading project data…');
        // simctl/devicectl block indefinitely until first-launch completes, so gate up
        // front and skip the Xcode-dependent probes. The enumeration helpers self-gate too.
        const xcodeReady = await isXcodeFirstLaunchComplete();
        if (!xcodeReady) {
            this.log('[sidebar] Xcode first-launch incomplete — simulator/device support unavailable until setup completes');
            promptXcodeFirstLaunch();
            startXcodeReadinessWatch();
        }
        const entries = await fsp.readdir(rootPath, { withFileTypes: true });
        const xcodeProjects = entries
            .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))
            .map((e) => e.name);

        let targets: NativeTarget[] = [];
        let schemes: string[] = [];
        const swiftVersionByTarget: Record<string, string> = {};
        const strictConcurrencyByTarget: Record<string, string> = {};
        const bundleIdByTarget: Record<string, string> = {};
        const productNameByTarget: Record<string, string> = {};
        const macSupportByTarget: Record<string, boolean> = {};

        const projectFile = config?.projectFile || xcodeProjects[0];
        if (projectFile) {
            const pbxprojPath = path.join(rootPath, projectFile, 'project.pbxproj');
            try {
                const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
                targets = parseNativeTargets(pbxContents);
                // Project-level settings act as the inheritance fallback for the
                // per-target lookups below (platforms, swift version, bundle id).
                const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
                for (const t of targets) {
                    productNameByTarget[t.name] = t.productName || t.name;
                    const settings = t.buildConfigurationListId
                        ? getBuildSettingsForTarget(pbxContents, t.buildConfigurationListId, 'Debug')
                        : null;
                    macSupportByTarget[t.name] = platformsSupported(settings, projectSettings).mac;
                    if (settings?.swiftVersion) {
                        swiftVersionByTarget[t.name] = settings.swiftVersion;
                    }
                    if (settings?.strictConcurrency) {
                        strictConcurrencyByTarget[t.name] = settings.strictConcurrency;
                    }
                    if (settings?.bundleIdentifier) {
                        bundleIdByTarget[t.name] = settings.bundleIdentifier;
                    }
                    if (settings?.productName && !settings.productName.includes('$(')) {
                        productNameByTarget[t.name] = settings.productName;
                    }
                }
                if (Object.keys(swiftVersionByTarget).length === 0 && projectSettings?.swiftVersion) {
                    for (const t of targets) {
                        swiftVersionByTarget[t.name] = projectSettings.swiftVersion;
                    }
                }
                if (Object.keys(strictConcurrencyByTarget).length === 0 && projectSettings?.strictConcurrency) {
                    for (const t of targets) {
                        strictConcurrencyByTarget[t.name] = projectSettings.strictConcurrency;
                    }
                }
                if (projectSettings?.bundleIdentifier) {
                    for (const t of targets) {
                        if (!bundleIdByTarget[t.name]) {
                            bundleIdByTarget[t.name] = projectSettings.bundleIdentifier;
                        }
                    }
                }
                // When SWIFT_STRICT_CONCURRENCY is absent, infer "minimal" for pre-Swift 6
                // (Swift 6+ has complete by default — hide the row instead of showing it)
                for (const t of targets) {
                    if (!strictConcurrencyByTarget[t.name]) {
                        const ver = swiftVersionByTarget[t.name];
                        const major = ver ? parseInt(ver, 10) : 0;
                        if (major > 0 && major < 6) {
                            strictConcurrencyByTarget[t.name] = 'minimal';
                        }
                    }
                }
            } catch { /* no pbxproj */ }

            // Scheme discovery needs xcodebuild; skip it when Xcode isn't ready.
            if (xcodeReady) {
                try {
                    const { stdout } = await execFile('xcodebuild', ['-list', '-project', path.join(rootPath, projectFile)], { encoding: 'utf8', timeout: 10000 });
                    const schemesMatch = /Schemes:\n([\s\S]*?)(?:\n\n|$)/.exec(stdout);
                    if (schemesMatch) {
                        schemes = schemesMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    }
                } catch (error) {
                    const message = (error as { message?: string }).message || String(error);
                    this.log(`[sidebar] xcodebuild -list failed: ${message}`);
                }
            }
        }

        // These probes self-gate on Xcode readiness, resolving empty instead of
        // hanging on a wedged simctl/devicectl when setup is incomplete.
        const [simulators, physicalDevices, supportedSwiftVersions, staleSimulatorInstalls] = await Promise.all([
            listAvailableSimulators(),
            listPhysicalDevices(),
            detectSupportedSwiftVersions(),
            this.findStaleSimulatorInstalls(config, bundleIdByTarget, productNameByTarget),
        ]);

        this.projectData = { xcodeProjects, targets, schemes, simulators, physicalDevices, swiftVersionByTarget, strictConcurrencyByTarget, bundleIdByTarget, productNameByTarget, macSupportByTarget, xcodeReady, supportedSwiftVersions, staleSimulatorInstalls };
        this.log(`[sidebar] project data loaded — ${targets.length} target(s), ${schemes.length} scheme(s), ${simulators.length} simulator(s), ${physicalDevices.length} device(s)`);
        // Force a fresh render now data is in; otherwise the spinner can persist until the view is re-entered.
        this._onDidChangeTreeData.fire();
    }

    private async findStaleSimulatorInstalls(
        config: BuildTaskConfig | null | undefined,
        bundleIdByTarget: Record<string, string>,
        productNameByTarget: Record<string, string>,
    ): Promise<InstalledAppSummary[]> {
        if (!config || config.isPhysicalDevice || !config.simulatorUdid) { return []; }
        const pbxBundleId = bundleIdByTarget[config.targetName];
        // Skip detection when pbxproj uses interpolation (e.g.
        // `com.example.$(PRODUCT_NAME)`) — the raw template won't match
        // any resolved bundle id from simctl, so the current install
        // would be misclassified as a stale orphan.
        if (!pbxBundleId || pbxBundleId.includes('$(')) { return []; }
        const productName = productNameByTarget[config.targetName] || config.productName;
        if (!productName) { return []; }
        const installed = await listInstalledSimulatorApps(config.simulatorUdid);
        // Both halves of the dev/production pair are expected, whichever way the toggle currently sits.
        const expected = new Set([pbxBundleId, effectiveBundleId(pbxBundleId, true)]);
        // Match on CFBundleName (defaults to the Xcode product name and is
        // rarely customized). CFBundleDisplayName isn't reliable because
        // users often override it independently of the product name, so a
        // displayName mismatch doesn't mean different app.
        return installed.filter((app) =>
            !expected.has(app.bundleId) && app.bundleName === productName
        );
    }

    updatePhysicalDevices(devices: PhysicalDevice[]): void {
        if (this.projectData) {
            this.projectData.physicalDevices = devices;
        }
    }

    getProjectData(): ProjectData | null {
        return this.projectData;
    }

    // ── Helpers ───────────────────────────────────────────────

    formatRuntime(runtime: string): string {
        const match = /SimRuntime\.(\w+)-(\d+)-(\d+)/.exec(runtime);
        if (match) {
            return `${match[1]} ${match[2]}.${match[3]}`;
        }
        return runtime;
    }
}

// ── Auto-configuration ───────────────────────────────────────────

export async function autoConfigureBuildTasks(
    workspaceState: vscode.Memento,
    provider: SidebarProvider
): Promise<boolean> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
        return false;
    }

    if (workspaceState.get<BuildTaskConfig>('buildTaskConfig')) {
        // Already configured — just load data for sidebar display
        await provider.loadProjectData(workspaceState.get<BuildTaskConfig>('buildTaskConfig'));
        provider.notifyConfigChanged();
        return true;
    }

    try {
        const entries = await fsp.readdir(rootPath, { withFileTypes: true });
        const xcodeProjects = entries
            .filter((e) => e.isDirectory() && e.name.endsWith('.xcodeproj'))
            .map((e) => e.name);
        if (xcodeProjects.length === 0) {
            return false;
        }
        const projectFile = xcodeProjects[0];

        const pbxprojPath = path.join(rootPath, projectFile, 'project.pbxproj');
        const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const nativeTargets = parseNativeTargets(pbxContents);
        const nonTestTargets = nativeTargets.filter((t) => !isTestTarget(t.productType));
        if (nonTestTargets.length === 0) {
            return false;
        }
        const target = nonTestTargets[0];

        let resolvedProductName = target.productName || target.name;
        if (target.buildConfigurationListId) {
            const settings = getBuildSettingsForTarget(
                pbxContents, target.buildConfigurationListId, 'Debug'
            );
            if (settings?.productName && !settings.productName.includes('$(')) {
                resolvedProductName = settings.productName;
            }
        }

        let schemeName = path.basename(projectFile, '.xcodeproj');
        if (await isXcodeFirstLaunchComplete()) {
            try {
                const { stdout } = await execFile('xcodebuild', ['-list', '-project', path.join(rootPath, projectFile)], { encoding: 'utf8', timeout: 10000 });
                const schemesMatch = /Schemes:\n([\s\S]*?)(?:\n\n|$)/.exec(stdout);
                if (schemesMatch) {
                    const schemes = schemesMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    if (schemes.length >= 1) {
                        schemeName = schemes.find((s) => s === target.name) || schemes[0];
                    }
                }
            } catch { /* fall back to the project-name scheme */ }
        } else {
            // Setup pending — skip scheme discovery and prompt, but keep going so a
            // macOS-capable target can still default to My Mac.
            promptXcodeFirstLaunch();
        }

        const targetSettings = target.buildConfigurationListId
            ? getBuildSettingsForTarget(pbxContents, target.buildConfigurationListId, 'Debug')
            : null;
        const projectSettings = getProjectBuildSettings(pbxContents, 'Debug');
        const caps = platformsSupported(targetSettings, projectSettings);

        const simulators = await listAvailableSimulators();
        let config: BuildTaskConfig;
        if (simulators.length > 0 && caps.ios) {
            const iphone = simulators.find((s) => s.name.startsWith('iPhone')) || simulators[0];
            config = {
                projectFile,
                schemeName,
                targetName: target.name,
                productName: resolvedProductName,
                simulatorDevice: iphone.name,
                simulatorUdid: iphone.udid,
                destinationType: 'simulator',
            };
        } else if (caps.mac) {
            // macOS-only project (or no simulators installed) — target the host Mac.
            config = {
                projectFile,
                schemeName,
                targetName: target.name,
                productName: resolvedProductName,
                simulatorDevice: 'My Mac',
                simulatorUdid: '',
                destinationType: 'mac',
            };
        } else {
            return false;
        }
        await workspaceState.update('buildTaskConfig', config);

        vscode.commands.executeCommand('setContext', 'vsxcode.buildTasksConfigured', true);

        await provider.loadProjectData(config);
        provider.notifyConfigChanged();

        return true;
    } catch {
        return false;
    }
}
