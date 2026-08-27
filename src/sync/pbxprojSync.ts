import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';
import * as fs from 'fs';

import { parseNativeTargets, isTestTarget, parseBuildPhaseIds } from '../parsers/targets';
import { parseGroups, findMainGroupId, resolveGroupForPath, buildGroupDirectories } from '../parsers/groups';
import type { PBXGroupInfo } from '../parsers/groups';
import { SPM_RESOURCE_DIR_EXTENSIONS } from '../types/constants';
import { determineTargetPath } from '../utils/path';

export interface TargetDirectoryMapping {
    absolutePath: string;
    targetName: string;
    sourcesBuildPhaseId: string;
    groupId: string;
    pbxprojPath: string;
    /** Relative path from workspace root to target directory (e.g., "MyApp" or "Sources/MyApp") */
    relativePath: string;
    /** Absolute dirs of the target's Xcode 16+ synchronized root groups; sync skips files under these (Xcode auto-discovers them) but not the rest of the target. */
    synchronizedRoots: string[];
}

export function buildTargetMappings(
    rootPath: string,
    pbxContents: string,
    pbxprojPath: string
): TargetDirectoryMapping[] {
    const mappings: TargetDirectoryMapping[] = [];
    const targets = parseNativeTargets(pbxContents);
    const groups = parseGroups(pbxContents);
    const mainGroupId = findMainGroupId(pbxContents);
    if (!mainGroupId) { return mappings; }
    const groupDirs = buildGroupDirectories(groups, mainGroupId, rootPath);

    for (const target of targets) {
        const isTest = isTestTarget(target.productType);
        const relativePath = determineTargetPath(rootPath, target.name, isTest, target.productName);
        const buildPhases = parseBuildPhaseIds(pbxContents, target.name);
        if (!buildPhases.sourcesBuildPhaseId) { continue; }

        const absolutePath = path.join(rootPath, relativePath);

        // Resolve each sync root group's on-disk dir via the group tree; fall back to <targetDir>/<group.path> if it's not reachable as a child.
        const synchronizedRoots: string[] = [];
        for (const syncId of target.fileSystemSynchronizedGroupIds) {
            const dir = groupDirs.get(syncId);
            if (dir) {
                synchronizedRoots.push(dir);
            } else {
                const syncGroup = groups.get(syncId);
                if (syncGroup?.path) {
                    synchronizedRoots.push(path.join(absolutePath, syncGroup.path));
                }
            }
        }

        const groupId = resolveGroupForPath(groups, mainGroupId, relativePath);
        if (!groupId) { continue; }

        mappings.push({
            absolutePath,
            targetName: target.name,
            sourcesBuildPhaseId: buildPhases.sourcesBuildPhaseId,
            groupId,
            pbxprojPath,
            relativePath,
            synchronizedRoots
        });
    }

    return mappings;
}

/** Whether a file lives under one of the target's synchronized root groups, which Xcode 16+ auto-discovers — those must not get explicit pbxproj refs. */
export function isUnderSynchronizedRoot(filePath: string, mapping: TargetDirectoryMapping): boolean {
    return mapping.synchronizedRoots.some((dir) => filePath.startsWith(dir + path.sep));
}

export function findMappingForFile(
    filePath: string,
    mappings: TargetDirectoryMapping[]
): TargetDirectoryMapping | null {
    let bestMatch: TargetDirectoryMapping | null = null;
    let bestLength = 0;

    for (const mapping of mappings) {
        const prefix = mapping.absolutePath + path.sep;
        if (filePath.startsWith(prefix) && prefix.length > bestLength) {
            bestMatch = mapping;
            bestLength = prefix.length;
        }
    }
    return bestMatch;
}

export function resolveGroupForFile(
    filePath: string,
    mapping: TargetDirectoryMapping,
    groups: Map<string, PBXGroupInfo>,
    mainGroupId: string
): string | null {
    const relativeToTarget = path.relative(mapping.absolutePath, path.dirname(filePath));

    // File is directly in the target root directory
    if (relativeToTarget === '' || relativeToTarget === '.') {
        return mapping.groupId;
    }

    // File is in a subdirectory — try to resolve the subgroup
    const subgroupPath = mapping.relativePath + '/' + relativeToTarget.split(path.sep).join('/');
    return resolveGroupForPath(groups, mainGroupId, subgroupPath);
}

export function findPbxprojPath(rootPath: string): string | null {
    try {
        const entries = fs.readdirSync(rootPath, { withFileTypes: true });
        const xcodeProject = entries.find(
            (e) => e.isDirectory() && e.name.endsWith('.xcodeproj')
        );
        if (xcodeProject) {
            return path.join(rootPath, xcodeProject.name, 'project.pbxproj');
        }
    } catch { /* ignore */ }
    return null;
}

// Serialize every pbxproj read-modify-write (watcher ops + reconcile) so they can't clobber each other; a failing op is isolated and never stalls the chain.
let writeChain: Promise<void> = Promise.resolve();

export function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
    const result = writeChain.then(op);
    writeChain = result.then(() => undefined, () => undefined);
    return result;
}

export interface OperationScheduler extends vscode.Disposable {
    /** Debounce per path, then run the operation on the shared pbxproj write queue. */
    schedule(filePath: string, operation: () => Promise<void>): void;
}

const DEBOUNCE_MS = 300;

/** Per-path debouncer feeding the shared write queue; pending work is dropped on dispose. */
export function createOperationScheduler(log: (message: string) => void, logPrefix: string): OperationScheduler {
    const pendingOps = new Map<string, ReturnType<typeof setTimeout>>();

    return {
        schedule(filePath, operation) {
            const existing = pendingOps.get(filePath);
            if (existing) { clearTimeout(existing); }

            pendingOps.set(filePath, setTimeout(() => {
                pendingOps.delete(filePath);
                enqueueWrite(async () => {
                    try {
                        await operation();
                    } catch (error) {
                        const message = (error as { message?: string }).message || String(error);
                        log(`${logPrefix} Error: ${message}`);
                    }
                });
            }, DEBOUNCE_MS));
        },
        dispose() {
            for (const timer of pendingOps.values()) { clearTimeout(timer); }
            pendingOps.clear();
        }
    };
}

export const RECONCILE_SKIP_DIRS = new Set([
    'build', 'DerivedData', 'Pods', 'Carthage', '.build', '.git', 'node_modules'
]);

// Directories that are opaque bundles rather than source trees — never descend into them.
const OPAQUE_DIR_EXTENSIONS = new Set([
    ...SPM_RESOURCE_DIR_EXTENSIONS,
    '.xcodeproj', '.xcworkspace', '.framework', '.app'
]);

/** Depth-first walk collecting whatever `collect` accepts; a collected directory is returned as-is and never descended into, so bundles stay single units. */
export async function walkTargetDirectory(
    dir: string,
    collect: (name: string, isDirectory: boolean) => boolean
): Promise<string[]> {
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
        return out; // Unreadable directory — skip it.
    }

    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (collect(entry.name, true)) {
                out.push(full);
                continue;
            }
            if (entry.name.startsWith('.') || RECONCILE_SKIP_DIRS.has(entry.name) ||
                OPAQUE_DIR_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                continue;
            }
            out.push(...await walkTargetDirectory(full, collect));
        } else if (entry.isFile() && collect(entry.name, false)) {
            out.push(full);
        }
    }
    return out;
}
