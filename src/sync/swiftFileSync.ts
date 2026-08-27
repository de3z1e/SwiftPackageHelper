import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fsp } from 'fs';

import { parseGroups, findMainGroupId } from '../parsers/groups';
import {
    addSwiftFileToPbxproj,
    removeSwiftFileFromPbxproj,
    findFileReferenceId
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

const LOG_PREFIX = '[swift-sync]';

export function createSwiftFileWatcher(
    rootPath: string,
    log: (message: string) => void
): vscode.Disposable[] {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) {
        log(`${LOG_PREFIX} No xcodeproj found, skipping Swift file watcher`);
        return [];
    }

    const watcher = vscode.workspace.createFileSystemWatcher('**/*.swift');
    const scheduler = createOperationScheduler(log, LOG_PREFIX);

    const onCreate = watcher.onDidCreate((uri) => {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        scheduler.schedule(filePath, async () => {
            const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');

            // Skip if file already registered in pbxproj
            if (findFileReferenceId(pbxContents, fileName)) {
                log(`${LOG_PREFIX} ${fileName} already in pbxproj, skipping`);
                return;
            }

            const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
            const mapping = findMappingForFile(filePath, mappings);
            if (!mapping) {
                return; // Not in a known target directory
            }

            // Files under a synchronized root group are auto-discovered by Xcode; others in the target still need adding.
            if (isUnderSynchronizedRoot(filePath, mapping)) {
                log(`${LOG_PREFIX} ${fileName} under synchronized group in ${mapping.targetName}, skipping`);
                return;
            }

            // Resolve the correct group (may be a subgroup for subdirectory files)
            const groups = parseGroups(pbxContents);
            const mainGroupId = findMainGroupId(pbxContents);
            if (!mainGroupId) { return; }

            const groupId = resolveGroupForFile(filePath, mapping, groups, mainGroupId);
            if (!groupId) {
                log(
                    `${LOG_PREFIX} No matching PBXGroup for ${path.relative(rootPath, filePath)}, skipping`
                );
                return;
            }

            const result = addSwiftFileToPbxproj(
                pbxContents, fileName, groupId, mapping.sourcesBuildPhaseId
            );
            await fsp.writeFile(pbxprojPath, result, 'utf8');
            log(
                `${LOG_PREFIX} Added ${fileName} to ${mapping.targetName}`
            );
        });
    });

    const onDelete = watcher.onDidDelete((uri) => {
        const filePath = uri.fsPath;
        const fileName = path.basename(filePath);

        scheduler.schedule(filePath, async () => {
            const pbxContents = await fsp.readFile(pbxprojPath, 'utf8');

            // Skip if file not in pbxproj (covers files under synchronized groups, which have no PBXFileReference entry)
            if (!findFileReferenceId(pbxContents, fileName)) {
                return;
            }

            const result = removeSwiftFileFromPbxproj(pbxContents, fileName);
            if (!result) { return; }

            await fsp.writeFile(pbxprojPath, result, 'utf8');
            log(
                `${LOG_PREFIX} Removed ${fileName} from pbxproj`
            );
        });
    });

    log(`${LOG_PREFIX} Swift file watcher active`);
    return [watcher, onCreate, onDelete, scheduler];
}

function walkSwiftFiles(dir: string): Promise<string[]> {
    return walkTargetDirectory(dir, (name, isDirectory) => !isDirectory && name.endsWith('.swift'));
}

/** Catch-up scan that registers on-disk Swift files the live watcher missed (added while VS Code was closed, or by git/external tooling). Returns the count added. */
export async function reconcileSwiftFiles(
    rootPath: string,
    log: (message: string) => void
): Promise<number> {
    const pbxprojPath = findPbxprojPath(rootPath);
    if (!pbxprojPath) { return 0; }

    // Read pbxproj inside the lock so we pick up any adds the watcher just applied before computing what's missing.
    return enqueueWrite(async () => {
        let pbxContents = await fsp.readFile(pbxprojPath, 'utf8');
        const mappings = buildTargetMappings(rootPath, pbxContents, pbxprojPath);
        if (mappings.length === 0) { return 0; }

        // Group tree is stable across file adds (no new groups created), so parse it once.
        const groups = parseGroups(pbxContents);
        const mainGroupId = findMainGroupId(pbxContents);
        if (!mainGroupId) { return 0; }

        // Assign each file to its most-specific (longest-prefix) target so nested-target files don't land in the enclosing target; dedup files reachable under multiple mappings.
        const seen = new Set<string>();
        const candidates: { filePath: string; fileName: string; mapping: TargetDirectoryMapping }[] = [];
        for (const mapping of mappings) {
            const files = await walkSwiftFiles(mapping.absolutePath);
            for (const filePath of files) {
                if (seen.has(filePath)) { continue; }
                seen.add(filePath);
                const owner = findMappingForFile(filePath, mappings) ?? mapping;
                if (isUnderSynchronizedRoot(filePath, owner)) { continue; }
                candidates.push({ filePath, fileName: path.basename(filePath), mapping: owner });
            }
        }

        let added = 0;
        for (const { filePath, fileName, mapping } of candidates) {
            // Re-check against the accumulating contents so we never double-add.
            if (findFileReferenceId(pbxContents, fileName)) { continue; }
            const groupId = resolveGroupForFile(filePath, mapping, groups, mainGroupId);
            if (!groupId) {
                log(`${LOG_PREFIX} reconcile: no PBXGroup for ${path.relative(rootPath, filePath)}, skipping`);
                continue;
            }
            pbxContents = addSwiftFileToPbxproj(pbxContents, fileName, groupId, mapping.sourcesBuildPhaseId);
            added++;
            log(`${LOG_PREFIX} reconcile: added ${fileName} to ${mapping.targetName}`);
        }

        if (added > 0) {
            await fsp.writeFile(pbxprojPath, pbxContents, 'utf8');
            log(`${LOG_PREFIX} reconcile: added ${added} file(s) to the project`);
        }
        return added;
    });
}
