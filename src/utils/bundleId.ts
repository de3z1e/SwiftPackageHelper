import { promisify } from 'util';
import { execFile as execFileCallback, exec as execCallback } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { getBuildSettingsForTarget, getProjectBuildSettings } from '../parsers/buildSettings';
import { parseNativeTargets } from '../parsers/targets';
import { isXcodeFirstLaunchComplete } from './version';
import type { BuildTaskConfig } from '../types/interfaces';

const execFile = promisify(execFileCallback);
const exec = promisify(execCallback);

export type BundleIdSource = 'info-plist' | 'pbxproj';

// ── Dev Bundle ID mode ───────────────────────────────────────────

/** Appended to PRODUCT_BUNDLE_IDENTIFIER while Dev Bundle ID is enabled. */
export const DEV_BUNDLE_ID_SUFFIX = '-dev';

/**
 * xcodebuild override suffixing whatever PRODUCT_BUNDLE_IDENTIFIER each target
 * resolves to, expanded at build time so nothing needs caching. The single
 * quotes are load-bearing: `zsh -c` would treat `$(inherited)` as a command
 * substitution.
 */
export function devBundleIdOverrideArgs(config: BuildTaskConfig): string[] {
    if (!config.devBundleId) { return []; }
    return [`'PRODUCT_BUNDLE_IDENTIFIER=$(inherited)${DEV_BUNDLE_ID_SUFFIX}'`];
}

/** The bundle id a build produces for a pbxproj value under the active mode. */
export function effectiveBundleId(baseBundleId: string, devBundleId?: boolean): string {
    return devBundleId ? `${baseBundleId}${DEV_BUNDLE_ID_SUFFIX}` : baseBundleId;
}

/** The dev/production counterpart of a bundle id — a deliberate pair, never an orphan of each other. */
export function counterpartBundleId(bundleId: string): string {
    return bundleId.endsWith(DEV_BUNDLE_ID_SUFFIX)
        ? bundleId.slice(0, -DEV_BUNDLE_ID_SUFFIX.length)
        : `${bundleId}${DEV_BUNDLE_ID_SUFFIX}`;
}

export interface ResolvedBundleId {
    bundleId: string;
    source: BundleIdSource;
}

/**
 * Read a top-level key from a plist via plutil. Returns undefined if the
 * plist is missing or the key is absent. Safe to call on a path that may
 * not exist (no build has happened yet).
 */
export async function readPlistKey(plistPath: string, key: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFile(
            'plutil',
            ['-extract', key, 'raw', '-o', '-', plistPath],
            { encoding: 'utf8' }
        );
        const value = stdout.trim();
        return value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
}

export async function readInfoPlistBundleId(infoPlistPath: string): Promise<string | undefined> {
    return readPlistKey(infoPlistPath, 'CFBundleIdentifier');
}

export async function readInfoPlistExecutable(infoPlistPath: string): Promise<string | undefined> {
    return readPlistKey(infoPlistPath, 'CFBundleExecutable');
}

export interface DisplayNames {
    name?: string;
    displayName?: string;
}

export async function readInfoPlistDisplayNames(infoPlistPath: string): Promise<DisplayNames> {
    const [name, displayName] = await Promise.all([
        readPlistKey(infoPlistPath, 'CFBundleName'),
        readPlistKey(infoPlistPath, 'CFBundleDisplayName'),
    ]);
    return { name, displayName };
}

/**
 * Resolve the bundle id to use at launch time. The freshly-built
 * Info.plist is canonical (xcodebuild reads current pbxproj on every
 * build, so the .app's plist holds the just-built value with any
 * interpolation resolved); pbxproj is the fallback when no build has
 * happened yet.
 */
export async function resolveBundleIdForLaunch(opts: {
    appPath?: string;
    pbxprojPath?: string;
    targetName?: string;
    configurationName?: string;
    devBundleId?: boolean;
}): Promise<ResolvedBundleId | undefined> {
    if (opts.appPath) {
        const infoPlist = path.join(opts.appPath, 'Info.plist');
        const fromPlist = await readInfoPlistBundleId(infoPlist);
        if (fromPlist) {
            // Already the built value, suffix included — never re-apply it.
            return { bundleId: fromPlist, source: 'info-plist' };
        }
    }
    if (opts.pbxprojPath && opts.targetName) {
        const fromPbx = await parseBundleIdFromPbxproj(
            opts.pbxprojPath,
            opts.targetName,
            opts.configurationName || 'Debug',
        );
        if (fromPbx) {
            // Raw pbxproj value: dev mode's suffix lives only in the build
            // override, so apply it here to match what a build would install.
            return { bundleId: effectiveBundleId(fromPbx, opts.devBundleId), source: 'pbxproj' };
        }
    }
    return undefined;
}

export async function parseBundleIdFromPbxproj(
    pbxprojPath: string,
    targetName: string,
    configurationName: string = 'Debug',
): Promise<string | undefined> {
    try {
        const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const targets = parseNativeTargets(pbxContents);
        const target = targets.find((t) => t.name === targetName);
        if (target?.buildConfigurationListId) {
            const settings = getBuildSettingsForTarget(
                pbxContents,
                target.buildConfigurationListId,
                configurationName,
            );
            if (settings?.bundleIdentifier) {
                return settings.bundleIdentifier;
            }
        }
        const projectSettings = getProjectBuildSettings(pbxContents, configurationName);
        return projectSettings?.bundleIdentifier || undefined;
    } catch {
        return undefined;
    }
}

export interface InstalledAppSummary {
    bundleId: string;
    bundleName?: string;
    displayName?: string;
}

/**
 * Query installed apps on a booted simulator via `xcrun simctl listapps`.
 * Filters out system apps and returns user-installed apps only.
 */
export async function listInstalledSimulatorApps(udid: string): Promise<InstalledAppSummary[]> {
    // simctl wedges when Xcode first-launch setup is incomplete — gate it.
    if (!(await isXcodeFirstLaunchComplete())) { return []; }
    try {
        // listapps emits an old-style plist keyed by bundle id; pipe through
        // plutil → JSON for reliable parsing.
        const { stdout: jsonOut } = await exec(
            `xcrun simctl listapps "${udid.replace(/"/g, '\\"')}" | plutil -convert json -r -o - -`,
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
        const parsed = JSON.parse(jsonOut) as Record<string, {
            CFBundleIdentifier?: string;
            CFBundleName?: string;
            CFBundleDisplayName?: string;
            ApplicationType?: string;
        }>;
        const apps: InstalledAppSummary[] = [];
        for (const entry of Object.values(parsed)) {
            const bundleId = entry.CFBundleIdentifier;
            if (!bundleId) { continue; }
            if (entry.ApplicationType && entry.ApplicationType !== 'User') { continue; }
            apps.push({
                bundleId,
                bundleName: entry.CFBundleName,
                displayName: entry.CFBundleDisplayName,
            });
        }
        return apps;
    } catch {
        return [];
    }
}

export async function uninstallSimulatorApp(udid: string, bundleId: string): Promise<void> {
    try {
        await execFile(
            'xcrun',
            ['simctl', 'uninstall', udid, bundleId],
            { encoding: 'utf8' },
        );
    } catch {
        // Best-effort: app may not be installed
    }
}

/**
 * Find the installed `.app` bundle directory on a booted simulator
 * (the app container, not the executable inside it). Returns undefined
 * if the app isn't installed.
 */
export async function findInstalledAppPath(udid: string, bundleId: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFile(
            'xcrun',
            ['simctl', 'get_app_container', udid, bundleId, 'app'],
            { encoding: 'utf8' },
        );
        const containerPath = stdout.trim();
        return containerPath.length > 0 ? containerPath : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Returns the mtime (in milliseconds) of the main executable inside an
 * installed app, or undefined if it can't be found. Used to confirm at a
 * glance that fresh code was actually installed.
 */
export async function getInstalledAppExecutableMtime(
    udid: string,
    bundleId: string,
): Promise<{ executablePath: string; mtimeMs: number } | undefined> {
    const appPath = await findInstalledAppPath(udid, bundleId);
    if (!appPath) { return undefined; }
    const infoPlist = path.join(appPath, 'Info.plist');
    const executable = await readInfoPlistExecutable(infoPlist);
    if (!executable) { return undefined; }
    const execPath = path.join(appPath, executable);
    try {
        const stat = await fsp.stat(execPath);
        return { executablePath: execPath, mtimeMs: stat.mtimeMs };
    } catch {
        return undefined;
    }
}

export function formatMtime(mtimeMs: number): string {
    return new Date(mtimeMs).toLocaleString();
}
