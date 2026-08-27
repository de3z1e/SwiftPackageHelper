import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';
import { promises as fsp } from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

import type { PlatformName } from '../types/interfaces';

const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string>,
    options?: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

// ── DerivedSources locations ─────────────────────────────
//
// Generated classes stay out of the repository, in a per-workspace tree under ~/Library.

const DERIVED_SOURCES_SEGMENTS = ['Library', 'Developer', 'VSCode', 'DerivedSources'];
const WORKSPACE_MARKER_FILE = 'workspace.json';
const OUTPUT_MANIFEST_FILE = 'manifest.json';
const STAGING_SUFFIX = '.generating';
const PRUNE_IGNORABLE_FILES = new Set(['.DS_Store']);

/** Absolute path to the root holding one DerivedSources tree per workspace. */
export function derivedSourcesBasePath(): string {
    return path.join(os.homedir(), ...DERIVED_SOURCES_SEGMENTS);
}

/** Stable, collision-proof directory name for a workspace: `<name>-<pathHash>`. */
export function workspaceKey(workspacePath: string): string {
    const normalized = path.resolve(workspacePath);
    const hash = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
    return `${path.basename(normalized)}-${hash}`;
}

/** Absolute path to one workspace's DerivedSources tree. */
export function derivedSourcesPathForWorkspace(workspacePath: string): string {
    return path.join(derivedSourcesBasePath(), workspaceKey(workspacePath));
}

/** `$HOME`-relative form of a workspace's tree, for embedding in Package.swift. */
export function derivedSourcesHomeRelativePath(workspacePath: string): string {
    return [...DERIVED_SOURCES_SEGMENTS, workspaceKey(workspacePath)].join('/');
}

/** Records the owning workspace: the key's hash is one-way, so an orphaned tree is otherwise untraceable. */
export async function writeWorkspaceMarker(treePath: string, workspacePath: string): Promise<void> {
    await fsp.mkdir(treePath, { recursive: true });
    await fsp.writeFile(
        path.join(treePath, WORKSPACE_MARKER_FILE),
        JSON.stringify({ workspacePath }, null, 2) + '\n',
        'utf8'
    );
}

// ── momc invocation ──────────────────────────────────────

interface MomcPlatform {
    sdk: string;
    deploymentFlag: string;
}

const MOMC_PLATFORMS: Record<PlatformName, MomcPlatform> = {
    iOS: { sdk: 'iphonesimulator', deploymentFlag: '--iphoneos-deployment-target' },
    macOS: { sdk: 'macosx', deploymentFlag: '--macosx-deployment-target' },
    tvOS: { sdk: 'appletvsimulator', deploymentFlag: '--appletvos-deployment-target' },
    watchOS: { sdk: 'watchsimulator', deploymentFlag: '--watchos-deployment-target' }
};

// Module-lifetime cache; a mid-session xcode-select switch keeps the old path
// until reload, and a removed toolchain surfaces as a momc failure (handled).
const sdkPathCache = new Map<string, string>();

async function sdkPath(sdk: string): Promise<string> {
    const cached = sdkPathCache.get(sdk);
    if (cached) { return cached; }
    const { stdout } = await execFile('xcrun', ['--sdk', sdk, '--show-sdk-path'], { encoding: 'utf8' });
    const resolved = stdout.trim();
    sdkPathCache.set(sdk, resolved);
    return resolved;
}

/** Safe to delete: carries the manifest, is empty, or (pre-manifest legacy) holds only `.swift` files. */
async function isExtensionOutputDir(dir: string): Promise<boolean | null> {
    let entries;
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return null; // Unreadable — report as uninspectable rather than foreign.
    }
    return entries.every((entry) =>
        entry.isFile() && (
            entry.name === OUTPUT_MANIFEST_FILE ||
            entry.name.endsWith('.swift') ||
            PRUNE_IGNORABLE_FILES.has(entry.name)
        )
    );
}

/**
 * Drops output dirs absent from `activeTargetDirs` and stale `.generating` leftovers.
 * An emptied tree goes entirely, `workspace.json` included — the next generation recreates both.
 */
export function pruneStaleDerivedSources(
    workspacePath: string,
    activeTargetDirs: ReadonlySet<string>,
    log: (message: string) => void = () => {}
): Promise<void> {
    const result = generationChain.then(() => runPrune(workspacePath, activeTargetDirs, log));
    generationChain = result.then(() => undefined, () => undefined);
    return result;
}

async function runPrune(
    workspacePath: string,
    activeTargetDirs: ReadonlySet<string>,
    log: (message: string) => void
): Promise<void> {
    const root = derivedSourcesPathForWorkspace(workspacePath);
    // Invariant, not reachable via inputs: everything deleted below sits under the extension's own base.
    if (!root.startsWith(derivedSourcesBasePath() + path.sep)) {
        throw new Error(`Refusing to prune ${root}: outside ${derivedSourcesBasePath()}`);
    }

    let entries;
    try {
        entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
        return; // No tree for this workspace — nothing to prune.
    }

    let keptForeign = false;
    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        // Serialization guarantees no run is mid-generation, so any staging dir is an interrupted run's leftover.
        if (!entry.name.endsWith(STAGING_SUFFIX) && activeTargetDirs.has(entry.name)) { continue; }
        const dir = path.join(root, entry.name);
        const removable = await isExtensionOutputDir(dir);
        if (removable) {
            await fsp.rm(dir, { recursive: true, force: true });
            log(`removed stale codegen output ${entry.name}`);
        } else {
            keptForeign = true;
            log(removable === null
                ? `left ${entry.name} in place: could not inspect it`
                : `left ${entry.name} in place: contains files the extension did not generate`);
        }
    }

    if (activeTargetDirs.size > 0 || keptForeign) { return; }
    let remaining: string[];
    try {
        remaining = await fsp.readdir(root);
    } catch {
        return;
    }
    if (remaining.every((name) => name === WORKSPACE_MARKER_FILE || PRUNE_IGNORABLE_FILES.has(name))) {
        await fsp.rm(root, { recursive: true, force: true });
        log('removed empty codegen tree for this workspace');
    }
}

export interface GenerateCoreDataSourcesOptions {
    /** Absolute paths of the target's `.xcdatamodeld` bundles. */
    modelPaths: string[];
    /** Target's output directory; replaced wholesale on every run, removed when nothing is emitted. */
    outputDir: string;
    /** SwiftPM module the classes must land in — the Package.swift target name. */
    moduleName: string;
    platform: PlatformName;
    deploymentTarget: string;
    /** Swift language major version, e.g. "5" or "6". */
    swiftVersion: string;
}

/**
 * Generated `.swift` paths for each model, sorted. Manual/None codegen emits
 * nothing, so an empty result is success. `outputDir` is replaced rather than
 * merged, so removed entities leave no stale classes; momc failures throw and
 * leave the previous `outputDir` intact.
 */
export async function generateCoreDataSources(
    options: GenerateCoreDataSourcesOptions
): Promise<string[]> {
    const result = generationChain.then(() => runGeneration(options));
    generationChain = result.then(() => undefined, () => undefined);
    return result;
}

// Serialized so one run's wipe can't land in the middle of another's momc loop.
let generationChain: Promise<void> = Promise.resolve();

async function runGeneration(options: GenerateCoreDataSourcesOptions): Promise<string[]> {
    const { modelPaths, outputDir, moduleName, platform, deploymentTarget, swiftVersion } = options;

    // The recursive wipes must never point outside the extension's own tree.
    if (!outputDir.startsWith(derivedSourcesBasePath() + path.sep)) {
        throw new Error(`Refusing to wipe ${outputDir}: outside ${derivedSourcesBasePath()}`);
    }

    // Swap in a staged sibling so an in-flight SourceKit-LSP index build never sees a
    // half-populated directory; runs are serialized, so the fixed suffix cannot collide.
    const stagingDir = `${outputDir}${STAGING_SUFFIX}`;
    await fsp.rm(stagingDir, { recursive: true, force: true });
    await fsp.mkdir(stagingDir, { recursive: true });

    const momcPlatform = MOMC_PLATFORMS[platform];
    const sdkroot = await sdkPath(momcPlatform.sdk);
    // momc wants the marketing form ("5.0"), matching Xcode's own invocation.
    const momcSwiftVersion = swiftVersion.includes('.') ? swiftVersion : `${swiftVersion}.0`;

    try {
        for (const modelPath of modelPaths) {
            await execFile('xcrun', [
                'momc',
                '--sdkroot', sdkroot,
                momcPlatform.deploymentFlag, deploymentTarget,
                '--module', moduleName,
                '--swift-version', momcSwiftVersion,
                '--action', 'generate',
                modelPath,
                stagingDir
            ], { encoding: 'utf8' });
        }
    } catch (error) {
        await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }

    const generatedNames = (await fsp.readdir(stagingDir))
        .filter((name) => name.endsWith('.swift'))
        .sort((a, b) => a.localeCompare(b));

    // Manual/None codegen emits nothing — drop any prior dir so such projects never churn the tree.
    if (generatedNames.length === 0) {
        await fsp.rm(stagingDir, { recursive: true, force: true });
        await fsp.rm(outputDir, { recursive: true, force: true });
        return [];
    }

    // Marks the directory as extension output so pruning never has to guess.
    await fsp.writeFile(
        path.join(stagingDir, OUTPUT_MANIFEST_FILE),
        JSON.stringify({ generatedBy: 'vsxcode', files: generatedNames }, null, 2) + '\n',
        'utf8'
    );

    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, outputDir);

    return generatedNames.map((name) => path.join(outputDir, name));
}
