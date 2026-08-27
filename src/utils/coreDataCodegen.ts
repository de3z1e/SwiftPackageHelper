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

export interface GenerateCoreDataSourcesOptions {
    /** Absolute paths of the target's `.xcdatamodeld` bundles. */
    modelPaths: string[];
    /** Target's output directory; replaced wholesale on every successful run. */
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
    const stagingDir = `${outputDir}.generating`;
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

    await fsp.rm(outputDir, { recursive: true, force: true });
    await fsp.rename(stagingDir, outputDir);

    const entries = await fsp.readdir(outputDir);
    return entries
        .filter((name) => name.endsWith('.swift'))
        .sort((a, b) => a.localeCompare(b))
        .map((name) => path.join(outputDir, name));
}
