import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';

import { parseGroups, findMainGroupId, buildGroupDirectories } from '../parsers/groups';
import { parseVersionGroups, versionGroupBaseName, versionGroupBundleName } from '../parsers/versionGroups';
import type { XCVersionGroupInfo } from '../parsers/versionGroups';
import {
    addDataModelToPbxproj,
    findFileReferenceId,
    findFileReferencePath,
    moveVersionGroupToGroup,
    removeDataModelFromPbxproj,
    updateVersionGroupVersions
} from '../writers/pbxproj';
import {
    buildTargetMappings,
    createOperationScheduler,
    enqueueWrite,
    findMappingForFile,
    findPbxprojPath,
    isUnderSynchronizedRoot,
    resolveGroupForFile,
    walkTargetDirectory
} from './pbxprojSync';
import type { TargetDirectoryMapping } from './pbxprojSync';

const LOG_PREFIX = '[datamodel-sync]';

/** A Core Data model bundle is a directory, so it is watched and reasoned about as one unit. */
const DATA_MODEL_EXTENSION = '.xcdatamodeld';
const MODEL_VERSION_EXTENSION = '.xcdatamodel';
const CURRENT_VERSION_FILE = '.xccurrentversion';

interface DataModelBundle {
    /** Bundle directory name, e.g. "MyApp.xcdatamodeld". */
    name: string;
    /** `.xcdatamodel` version directories inside the bundle, alphabetically. */
    versionNames: string[];
    /** Version momc compiles against — from `.xccurrentversion`, else the sole version. */
    currentVersionName: string;
}

// ── Reading the bundle from disk ─────────────────────────

/** The `_XCCurrentVersionName` value from a bundle's `.xccurrentversion` plist. */
async function readDeclaredCurrentVersion(bundlePath: string): Promise<string | null> {
    try {
        const contents = await fsp.readFile(path.join(bundlePath, CURRENT_VERSION_FILE), 'utf8');
        const match = /<key>\s*_XCCurrentVersionName\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(contents);
        return match ? match[1].trim() : null;
    } catch {
        return null; // Missing or unreadable — the caller falls back to the sole version.
    }
}

/** Read a `.xcdatamodeld` bundle, or null when it holds no `.xcdatamodel` version yet. */
async function readDataModelBundle(
    bundlePath: string,
    log: (message: string) => void
): Promise<DataModelBundle | null> {
    let entries;
    try {
        entries = await fsp.readdir(bundlePath, { withFileTypes: true });
    } catch {
        return null;
    }

    const versionNames = entries
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(MODEL_VERSION_EXTENSION))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    if (versionNames.length === 0) { return null; }

    const name = path.basename(bundlePath);
    const declared = await readDeclaredCurrentVersion(bundlePath);
    if (declared && versionNames.includes(declared)) {
        return { name, versionNames, currentVersionName: declared };
    }
    if (versionNames.length > 1) {
        log(`${LOG_PREFIX} ${name} has ${versionNames.length} versions and no usable ${CURRENT_VERSION_FILE}, using ${versionNames[0]}`);
    }
    return { name, versionNames, currentVersionName: versionNames[0] };
}

function walkDataModelBundles(dir: string): Promise<string[]> {
    return walkTargetDirectory(
        dir,
        (name, isDirectory) => isDirectory && name.endsWith(DATA_MODEL_EXTENSION)
    );
}

/** Every `.xcdatamodeld` bundle on disk under the project's target directories. */
async function findBundlesOnDisk(mappings: TargetDirectoryMapping[]): Promise<string[]> {
    const seen = new Set<string>();
    for (const mapping of mappings) {
        for (const bundlePath of await walkDataModelBundles(mapping.absolutePath)) {
            seen.add(bundlePath);
        }
    }
    return [...seen];
}

// ── Matching pbxproj entries to disk ─────────────────────

/** Absolute on-disk path per XCVersionGroup; unresolvable groups are left out rather than guessed at, since a wrong path here would look like a deleted model. */
function resolveVersionGroupPaths(
    rootPath: string,
    pbxContents: string,
    versionGroups: XCVersionGroupInfo[]
): Map<string, string> {
    const resolved = new Map<string, string>();
    const groups = parseGroups(pbxContents);
    const mainGroupId = findMainGroupId(pbxContents);
    if (!mainGroupId) { return resolved; }

    const groupDirs = buildGroupDirectories(groups, mainGroupId, rootPath);
    const parentOf = new Map<string, string>();
    for (const [groupId, group] of groups) {
        for (const childId of group.childIds) {
            parentOf.set(childId, groupId);
        }
    }

    for (const versionGroup of versionGroups) {
        // Only group-relative entries resolve through the group tree; anything
        // else (e.g. SOURCE_ROOT) is left unresolved and therefore unmanaged
        // by the location logic — refresh still works, re-homing never fires.
        if (versionGroup.sourceTree !== undefined && versionGroup.sourceTree !== '<group>') { continue; }
        const bundleName = versionGroupBundleName(versionGroup);
        const parentId = parentOf.get(versionGroup.id);
        const parentDir = parentId ? groupDirs.get(parentId) : undefined;
        if (!bundleName || !parentDir) { continue; }
        resolved.set(versionGroup.id, path.join(parentDir, bundleName));
    }
    return resolved;
}

interface DataModelIndex {
    versionGroups: XCVersionGroupInfo[];
    /** XCVersionGroup id → resolved absolute path, for the groups we could place. */
    paths: Map<string, string>;
}

function indexVersionGroups(rootPath: string, pbxContents: string): DataModelIndex {
    const versionGroups = parseVersionGroups(pbxContents);
    return { versionGroups, paths: resolveVersionGroupPaths(rootPath, pbxContents, versionGroups) };
}

/** The XCVersionGroup registering `bundlePath`: exact path match first, then bundle name only when unambiguous, so same-named models are never edited on a guess. */
function findVersionGroupForBundle(index: DataModelIndex, bundlePath: string): XCVersionGroupInfo | null {
    const byPath = index.versionGroups.find((group) => index.paths.get(group.id) === bundlePath);
    if (byPath) { return byPath; }

    const bundleName = path.basename(bundlePath);
    const byName = index.versionGroups.filter((group) => versionGroupBaseName(group) === bundleName);
    return byName.length === 1 ? byName[0] : null;
}

/** The versions an XCVersionGroup currently records, resolved through its PBXFileReferences. */
function registeredVersions(
    pbxContents: string,
    versionGroup: XCVersionGroupInfo
): { names: string[]; currentName: string | null } {
    const names: string[] = [];
    for (const childId of versionGroup.childIds) {
        const versionPath = findFileReferencePath(pbxContents, childId);
        // An unresolvable child is left out, which reads as drift and triggers a re-register.
        if (versionPath) { names.push(versionPath); }
    }
    const currentName = versionGroup.currentVersionId
        ? findFileReferencePath(pbxContents, versionGroup.currentVersionId)
        : null;
    return { names, currentName };
}

function registrationMatchesDisk(
    pbxContents: string,
    versionGroup: XCVersionGroupInfo,
    bundle: DataModelBundle
): boolean {
    const registered = registeredVersions(pbxContents, versionGroup);
    return registered.currentName === bundle.currentVersionName &&
        registered.names.length === bundle.versionNames.length &&
        registered.names.every((name) => bundle.versionNames.includes(name));
}

interface RegisterOutcome {
    pbxContents: string;
    result: 'added' | 'updated' | 'unchanged';
}

/** Add the bundle when missing, or re-register it when its versions drifted — a `currentVersion` pointing at a missing version is the same momc failure as no entry at all. */
async function registerBundle(
    rootPath: string,
    pbxContents: string,
    bundlePath: string,
    mapping: TargetDirectoryMapping,
    log: (message: string) => void
): Promise<RegisterOutcome> {
    const unchanged: RegisterOutcome = { pbxContents, result: 'unchanged' };
    const bundleName = path.basename(bundlePath);

    const bundle = await readDataModelBundle(bundlePath, log);
    if (!bundle) {
        // Likely a bundle still being written; the next event or reconcile picks it up.
        log(`${LOG_PREFIX} ${bundleName} contains no ${MODEL_VERSION_EXTENSION} version, skipping`);
        return unchanged;
    }

    let contents = pbxContents;
    const index = indexVersionGroups(rootPath, contents);
    const versionGroup = findVersionGroupForBundle(index, bundlePath);
    const mainGroupId = findMainGroupId(contents);
    if (!mainGroupId) { return unchanged; }

    if (versionGroup) {
        // Relocation applies only when the registered location is actually
        // gone. If pbxproj's copy of the bundle still exists on disk, this is
        // an unregistered same-named duplicate — refreshing or re-homing from
        // it would hijack the original's registration.
        const resolvedPath = index.paths.get(versionGroup.id);
        const isRelocation = resolvedPath !== undefined && resolvedPath !== bundlePath;
        if (isRelocation && await pathExists(resolvedPath)) {
            log(`${LOG_PREFIX} ${path.relative(rootPath, bundlePath)} duplicates the registered ${bundleName}, skipping`);
            return unchanged;
        }

        let changed = false;

        // Corrected in place so other targets' PBXBuildFile and Sources entries survive.
        if (!registrationMatchesDisk(contents, versionGroup, bundle)) {
            const updated = updateVersionGroupVersions(
                contents, versionGroup.id, bundle.versionNames, bundle.currentVersionName
            );
            if (!updated) { return unchanged; }
            contents = updated;
            changed = true;
            log(`${LOG_PREFIX} ${bundleName} versions changed on disk, refreshing (current version ${bundle.currentVersionName})`);
        }

        // The group child determines the bundle's on-disk directory, so a moved bundle is re-homed in place.
        if (isRelocation) {
            const groupId = resolveGroupForFile(bundlePath, mapping, parseGroups(contents), mainGroupId);
            if (groupId) {
                contents = moveVersionGroupToGroup(contents, versionGroup.id, groupId, bundle.name);
                changed = true;
                log(`${LOG_PREFIX} ${bundleName} moved on disk, re-homing its group entry`);
            } else {
                log(`${LOG_PREFIX} No matching PBXGroup for ${path.relative(rootPath, bundlePath)}, keeping previous group entry`);
            }
        }

        return changed ? { pbxContents: contents, result: 'updated' } : unchanged;
    }

    if (index.versionGroups.some((group) => versionGroupBaseName(group) === bundleName)) {
        log(`${LOG_PREFIX} ${bundleName} matches an existing XCVersionGroup that could not be placed on disk, skipping`);
        return unchanged;
    }
    // An XCVersionGroup beside a legacy plain PBXFileReference would register the model twice.
    if (findFileReferenceId(contents, bundleName)) {
        log(`${LOG_PREFIX} ${bundleName} is already referenced as a plain file reference, skipping`);
        return unchanged;
    }

    const groupId = resolveGroupForFile(bundlePath, mapping, parseGroups(contents), mainGroupId);
    if (!groupId) {
        log(`${LOG_PREFIX} No matching PBXGroup for ${path.relative(rootPath, bundlePath)}, skipping`);
        return unchanged;
    }

    contents = addDataModelToPbxproj(
        contents,
        bundle.name,
        bundle.versionNames,
        bundle.currentVersionName,
        groupId,
        mapping.sourcesBuildPhaseId
    );
    log(`${LOG_PREFIX} Registered ${bundle.name} in ${mapping.targetName} (current version ${bundle.currentVersionName})`);
    return { pbxContents: contents, result: 'added' };
}

// ── Watcher ──────────────────────────────────────────────

export function createDataModelWatcher(
    rootPath: string,
    log: (message: string) => void,
    onSynced?: () => void
): vscode.Disposable[] {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) {
        log(`${LOG_PREFIX} No xcodeproj found, skipping Core Data model watcher`);
        return [];
    }

    /** Sync one bundle from disk state rather than the event kind, since a rename or atomic replace may have landed either way by the time the debounce fires. Returns whether the project tracks the bundle. */
    const syncBundle = async (bundlePath: string): Promise<boolean> => {
        const bundleName = path.basename(bundlePath);
        const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
        const mapping = findMappingForFile(bundlePath, mappings);

        if (!await pathExists(bundlePath)) {
            const index = indexVersionGroups(rootPath, pbxContents);
            const versionGroup = findVersionGroupForBundle(index, bundlePath);
            // Not registered, or ambiguous by name — leave the project alone.
            if (!versionGroup) { return mapping !== null; }

            // A same-named bundle still on disk is a move, not a deletion; the create event re-homes it.
            const remaining = await findBundlesOnDisk(mappings);
            if (remaining.some((p) => path.basename(p) === bundleName)) {
                log(`${LOG_PREFIX} ${bundleName} still on disk elsewhere, keeping registration`);
                return true;
            }

            const result = removeDataModelFromPbxproj(pbxContents, versionGroup.id);
            if (!result) { return true; }
            await fsp.writeFile(pbxprojPath, result, 'utf8');
            log(`${LOG_PREFIX} Removed ${bundleName} from pbxproj`);
            return true;
        }

        if (!mapping) {
            return false; // Not in a known target directory
        }

        // Bundles under a synchronized root group are auto-discovered by Xcode.
        if (isUnderSynchronizedRoot(bundlePath, mapping)) {
            log(`${LOG_PREFIX} ${bundleName} under synchronized group in ${mapping.targetName}, skipping`);
            return true;
        }

        const outcome = await registerBundle(rootPath, pbxContents, bundlePath, mapping, log);
        if (outcome.result !== 'unchanged') {
            await fsp.writeFile(pbxprojPath, outcome.pbxContents, 'utf8');
        }
        return true;
    };

    // The glob matches the bundle directory itself — the unit Xcode tracks — not the files inside it.
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${DATA_MODEL_EXTENSION}`);
    const scheduler = createOperationScheduler(log, LOG_PREFIX);

    const handleBundleEvent = (uri: vscode.Uri): void => {
        const bundlePath = uri.fsPath;
        scheduler.schedule(bundlePath, async () => {
            // Package.swift derives the bundle's .process(...) resource from disk, so a regen can be due even when pbxproj didn't change.
            if (await syncBundle(bundlePath)) {
                onSynced?.();
            }
        });
    };

    const onCreate = watcher.onDidCreate(handleBundleEvent);
    const onDelete = watcher.onDidDelete(handleBundleEvent);

    log(`${LOG_PREFIX} Core Data model watcher active`);
    return [watcher, onCreate, onDelete, scheduler];
}

async function pathExists(target: string): Promise<boolean> {
    try {
        await fsp.stat(target);
        return true;
    } catch {
        return false;
    }
}

// ── Reconcile ────────────────────────────────────────────

export interface DataModelReconcileResult {
    added: number;
    /** Models whose recorded versions no longer matched the bundle on disk. */
    updated: number;
    removed: number;
}

/** Catch-up scan that also clears stale entries: an XCVersionGroup left behind by a bundle deleted outside the watcher fails the build with momc's "No current version for model". */
export async function reconcileDataModels(
    rootPath: string,
    log: (message: string) => void
): Promise<DataModelReconcileResult> {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) { return { added: 0, updated: 0, removed: 0 }; }

    // Read pbxproj inside the lock so watcher edits land before we diff against disk.
    return enqueueWrite(async () => {
        let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
        if (mappings.length === 0) { return { added: 0, updated: 0, removed: 0 }; }

        const bundlesOnDisk = await findBundlesOnDisk(mappings);
        const pathsOnDisk = new Set(bundlesOnDisk);
        const namesOnDisk = new Set(bundlesOnDisk.map((bundlePath) => path.basename(bundlePath)));

        // ── Remove XCVersionGroups whose bundle is gone ──
        // The name check keeps an unresolvable group tree from being read as a deletion.
        let removed = 0;
        const index = indexVersionGroups(rootPath, pbxContents);
        for (const versionGroup of index.versionGroups) {
            const bundleName = versionGroupBaseName(versionGroup);
            if (!bundleName) { continue; }
            const resolvedPath = index.paths.get(versionGroup.id);
            if ((resolvedPath && pathsOnDisk.has(resolvedPath)) || namesOnDisk.has(bundleName)) {
                continue;
            }
            const result = removeDataModelFromPbxproj(pbxContents, versionGroup.id);
            if (!result) { continue; }
            pbxContents = result;
            removed++;
            log(`${LOG_PREFIX} reconcile: removed ${bundleName} (no longer on disk)`);
        }

        // ── Add bundles on disk the project doesn't know about, and refresh any whose versions drifted ──
        let added = 0;
        let updated = 0;
        for (const bundlePath of bundlesOnDisk) {
            const mapping = findMappingForFile(bundlePath, mappings);
            if (!mapping || isUnderSynchronizedRoot(bundlePath, mapping)) { continue; }

            // Run against the accumulating contents so each pass sees the last one's edits.
            const outcome = await registerBundle(rootPath, pbxContents, bundlePath, mapping, log);
            if (outcome.result === 'unchanged') { continue; }
            pbxContents = outcome.pbxContents;
            if (outcome.result === 'added') { added++; } else { updated++; }
        }

        if (added > 0 || updated > 0 || removed > 0) {
            await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            log(`${LOG_PREFIX} reconcile: added ${added}, updated ${updated}, removed ${removed} Core Data model(s)`);
        }
        return { added, updated, removed };
    });
}
