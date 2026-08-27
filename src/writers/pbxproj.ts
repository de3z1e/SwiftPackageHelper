import * as crypto from 'crypto';

import { cleanup } from '../utils/version';
import {
    findVersionGroupSection,
    parseVersionGroups,
    VERSION_GROUP_SECTION_BEGIN,
    VERSION_GROUP_SECTION_END
} from '../parsers/versionGroups';

// ── ID Generation ────────────────────────────────────────

export function collectExistingIds(pbxContents: string): Set<string> {
    const ids = new Set<string>();
    const idRegex = /\b([A-F0-9]{24})\b/g;
    let match: RegExpExecArray | null;
    while ((match = idRegex.exec(pbxContents)) !== null) {
        ids.add(match[1]);
    }
    return ids;
}

export function generateUniqueId(existingIds: Set<string>): string {
    let id: string;
    do {
        id = crypto.randomBytes(12).toString('hex').toUpperCase();
    } while (existingIds.has(id));
    return id;
}

// ── Helpers ──────────────────────────────────────────────

function needsQuoting(value: string): boolean {
    return /[^A-Za-z0-9._]/.test(value);
}

function formatPath(fileName: string): string {
    return needsQuoting(fileName) ? `"${fileName}"` : fileName;
}

function extractCommentName(line: string): string | null {
    const match = /\/\*\s*([^*]+?)\s*\*\//.exec(line);
    return match ? match[1] : null;
}

/** Extract leading whitespace from the first line containing a pbxproj ID. */
function detectIndent(lines: string[], fallback: string): string {
    for (const line of lines) {
        const m = /^(\s+)[A-F0-9]{24}\s/.exec(line);
        if (m) { return m[1]; }
    }
    return fallback;
}

/** Find the insertion offset within a pbxproj section to maintain ascending ID order. */
function findIdOrderInsertOffset(
    pbxContents: string,
    sectionStartIdx: number,
    sectionEndIdx: number,
    newId: string
): number {
    const sectionBody = pbxContents.slice(sectionStartIdx, sectionEndIdx);
    const lines = sectionBody.split('\n');
    const idPattern = /^\s*([A-F0-9]{24})\s/;

    let offset = sectionStartIdx;
    for (const line of lines) {
        const match = idPattern.exec(line);
        if (match && match[1] > newId) {
            return offset;
        }
        offset += line.length + 1;
    }
    return sectionEndIdx;
}

/** Comparable-entry filter matching the .swift children `addToGroup` sorts among by default. */
function isSwiftEntry(commentName: string): boolean {
    return commentName.endsWith('.swift') || commentName.includes('.swift ');
}

/** Comparable-entry filter that sorts among every named child, the way Xcode orders a group. */
export function anyEntry(): boolean {
    return true;
}

/** Find the alphabetical insertion offset among the entries `comparable` accepts. */
function findAlphabeticalInsertOffset(
    lines: string[],
    baseOffset: number,
    defaultOffset: number,
    fileName: string,
    comparable: (commentName: string) => boolean
): number {
    let lastComparableLineEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        const commentName = extractCommentName(lines[i]);
        if (!commentName) { continue; }
        if (!comparable(commentName)) { continue; }

        if (commentName.localeCompare(fileName, undefined, { sensitivity: 'base' }) > 0) {
            // Insert before this entry
            let offset = baseOffset;
            for (let j = 0; j < i; j++) {
                offset += lines[j].length + 1;
            }
            return offset;
        }

        // Track the end of this line as fallback insertion point
        let offset = baseOffset;
        for (let j = 0; j <= i; j++) {
            offset += lines[j].length + 1;
        }
        lastComparableLineEnd = offset;
    }
    // Insert after the last comparable entry, or fall back to end
    return lastComparableLineEnd !== -1 ? lastComparableLineEnd : defaultOffset;
}

// ── Adding a File ────────────────────────────────────────

export function addFileReference(
    pbxContents: string,
    fileRefId: string,
    fileName: string,
    lastKnownFileType: string = 'sourcecode.swift'
): string {
    const endMarker = '/* End PBXFileReference section */';
    const endIdx = pbxContents.indexOf(endMarker);
    if (endIdx === -1) { return pbxContents; }

    const startMarker = '/* Begin PBXFileReference section */';
    const startIdx = pbxContents.indexOf(startMarker);
    if (startIdx === -1) { return pbxContents; }

    const sectionBody = pbxContents.slice(startIdx, endIdx);
    const lines = sectionBody.split('\n');
    const indent = detectIndent(lines.slice(1), '\t\t');

    const entry = `${indent}${fileRefId} /* ${fileName} */ = {isa = PBXFileReference; lastKnownFileType = ${lastKnownFileType}; path = ${formatPath(fileName)}; sourceTree = "<group>"; };\n`;
    const insertAt = findIdOrderInsertOffset(pbxContents, startIdx, endIdx, fileRefId);
    return pbxContents.slice(0, insertAt) + entry + pbxContents.slice(insertAt);
}

export function addBuildFile(
    pbxContents: string,
    buildFileId: string,
    fileRefId: string,
    fileName: string
): string {
    const endMarker = '/* End PBXBuildFile section */';
    const endIdx = pbxContents.indexOf(endMarker);
    if (endIdx === -1) { return pbxContents; }

    const startMarker = '/* Begin PBXBuildFile section */';
    const startIdx = pbxContents.indexOf(startMarker);
    if (startIdx === -1) { return pbxContents; }

    const sectionBody = pbxContents.slice(startIdx, endIdx);
    const lines = sectionBody.split('\n');
    const indent = detectIndent(lines.slice(1), '\t\t');

    const entry = `${indent}${buildFileId} /* ${fileName} in Sources */ = {isa = PBXBuildFile; fileRef = ${fileRefId} /* ${fileName} */; };\n`;
    const insertAt = findIdOrderInsertOffset(pbxContents, startIdx, endIdx, buildFileId);
    return pbxContents.slice(0, insertAt) + entry + pbxContents.slice(insertAt);
}

export function addToGroup(
    pbxContents: string,
    groupId: string,
    fileRefId: string,
    fileName: string,
    comparable: (commentName: string) => boolean = isSwiftEntry
): string {
    // Find the group entry by its ID
    const groupPattern = new RegExp(
        groupId + '\\s*(?:\\/\\*[^*]*\\*\\/\\s*)?=\\s*\\{[\\s\\S]*?children\\s*=\\s*\\('
    );
    const groupMatch = groupPattern.exec(pbxContents);
    if (!groupMatch) { return pbxContents; }

    const childrenStart = groupMatch.index + groupMatch[0].length;

    // Find the closing paren of children = (...)
    const closingParenIdx = pbxContents.indexOf(')', childrenStart);
    if (closingParenIdx === -1) { return pbxContents; }

    const childrenBlock = pbxContents.slice(childrenStart, closingParenIdx);
    const childLines = childrenBlock.split('\n');
    const indent = detectIndent(childLines, '\t\t\t\t');
    const newEntry = `${indent}${fileRefId} /* ${fileName} */,\n`;

    // Default insertion: before the newline that precedes the closing )
    const lastNewline = pbxContents.lastIndexOf('\n', closingParenIdx);
    const defaultInsert = lastNewline !== -1 ? lastNewline + 1 : closingParenIdx;
    const insertOffset = findAlphabeticalInsertOffset(childLines, childrenStart, defaultInsert, fileName, comparable);
    return pbxContents.slice(0, insertOffset) + newEntry + pbxContents.slice(insertOffset);
}

export function addToSourcesBuildPhase(
    pbxContents: string,
    sourcesBuildPhaseId: string,
    buildFileId: string,
    fileName: string
): string {
    // Find the Sources build phase by its ID
    const phasePattern = new RegExp(
        sourcesBuildPhaseId + '\\s*(?:\\/\\*[^*]*\\*\\/\\s*)?=\\s*\\{[\\s\\S]*?files\\s*=\\s*\\('
    );
    const phaseMatch = phasePattern.exec(pbxContents);
    if (!phaseMatch) { return pbxContents; }

    const filesStart = phaseMatch.index + phaseMatch[0].length;
    const closingParenIdx = pbxContents.indexOf(')', filesStart);
    if (closingParenIdx === -1) { return pbxContents; }

    const filesBlock = pbxContents.slice(filesStart, closingParenIdx);
    const fileLines = filesBlock.split('\n');
    const indent = detectIndent(fileLines, '\t\t\t\t');
    const newEntry = `${indent}${buildFileId} /* ${fileName} in Sources */,\n`;

    // Insert before the newline that precedes the closing ), not at ) itself
    const lastNewline = pbxContents.lastIndexOf('\n', closingParenIdx);
    const insertAt = lastNewline !== -1 ? lastNewline + 1 : closingParenIdx;
    return pbxContents.slice(0, insertAt) + newEntry + pbxContents.slice(insertAt);
}

export function addSwiftFileToPbxproj(
    pbxContents: string,
    fileName: string,
    groupId: string,
    sourcesBuildPhaseId: string
): string {
    const existingIds = collectExistingIds(pbxContents);
    const buildFileId = generateUniqueId(existingIds);
    existingIds.add(buildFileId);
    const fileRefId = generateUniqueId(existingIds);

    let result = pbxContents;
    result = addBuildFile(result, buildFileId, fileRefId, fileName);
    result = addFileReference(result, fileRefId, fileName);
    result = addToGroup(result, groupId, fileRefId, fileName);
    result = addToSourcesBuildPhase(result, sourcesBuildPhaseId, buildFileId, fileName);
    return result;
}

// ── Finding entries for removal ──────────────────────────

export function findFileReferenceId(
    pbxContents: string,
    fileName: string
): string | null {
    const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `([A-F0-9]{24})\\s*\\/\\*\\s*${escaped}\\s*\\*\\/\\s*=\\s*\\{[^}]*isa\\s*=\\s*PBXFileReference`
    );
    const match = pattern.exec(pbxContents);
    return match ? match[1] : null;
}

/** The `path` of a PBXFileReference, for checking a recorded entry against disk. */
export function findFileReferencePath(
    pbxContents: string,
    fileRefId: string
): string | null {
    const pattern = new RegExp(
        `^[\\t ]*${fileRefId}\\s*(?:\\/\\*[^*]*\\*\\/\\s*)?=\\s*\\{[^}]*\\bpath\\s*=\\s*([^;]+);`,
        'm'
    );
    const match = pattern.exec(pbxContents);
    return match ? cleanup(match[1]) : null;
}

export function findBuildFileId(
    pbxContents: string,
    fileRefId: string
): string | null {
    const pattern = new RegExp(
        `([A-F0-9]{24})\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*fileRef\\s*=\\s*${fileRefId}`
    );
    const match = pattern.exec(pbxContents);
    return match ? match[1] : null;
}

// ── Removing a File ──────────────────────────────────────

export function removeFileReference(
    pbxContents: string,
    fileRefId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${fileRefId}\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\};\\s*\\n`, 'm');
    return pbxContents.replace(pattern, '');
}

export function removeBuildFile(
    pbxContents: string,
    buildFileId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${buildFileId}\\s*\\/\\*[^*]*\\*\\/\\s*=\\s*\\{[^}]*\\};\\s*\\n`, 'm');
    return pbxContents.replace(pattern, '');
}

export function removeFromGroup(
    pbxContents: string,
    fileRefId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${fileRefId}\\s*\\/\\*[^*]*\\*\\/,\\s*\\n`, 'gm');
    return pbxContents.replace(pattern, '');
}

export function removeFromSourcesBuildPhase(
    pbxContents: string,
    buildFileId: string
): string {
    const pattern = new RegExp(`^[\\t ]*${buildFileId}\\s*\\/\\*[^*]*\\*\\/,\\s*\\n`, 'gm');
    return pbxContents.replace(pattern, '');
}

export function updateBuildSetting(
    pbxContents: string,
    configId: string,
    key: string,
    value: string
): string {
    // Match the XCBuildConfiguration block by its ID
    const blockRegex = new RegExp(
        `(${configId}\\s*/\\*[^*]*\\*/\\s*=\\s*\\{[^}]*buildSettings\\s*=\\s*\\{)((?:[^}]|\\}(?!;))*)(\\};\\s*name)`,
    );
    const blockMatch = blockRegex.exec(pbxContents);
    if (!blockMatch) { return pbxContents; }

    const settingsBlock = blockMatch[2];
    const settingRegex = new RegExp(`([ \\t]*)${key} = [^;]*;`);
    const existingMatch = settingRegex.exec(settingsBlock);

    let newSettings: string;
    if (existingMatch) {
        newSettings = settingsBlock.replace(settingRegex, `${existingMatch[1]}${key} = ${value};`);
    } else {
        // Insert new setting before the closing of buildSettings block
        const indentMatch = /^([ \t]+)\w/.exec(settingsBlock.split('\n').find(l => /^\s+\w/.test(l)) || '');
        const indent = indentMatch ? indentMatch[1] : '\t\t\t\t';
        const newLine = `\n${indent}${key} = ${value};`;
        // Try inserting before trailing whitespace, or append before end
        const trailingMatch = /(\n)([ \t]*$)/.exec(settingsBlock);
        if (trailingMatch) {
            newSettings = settingsBlock.replace(/(\n)([ \t]*$)/, `${newLine}\n$2`);
        } else {
            newSettings = settingsBlock + newLine + '\n';
        }
    }

    return pbxContents.slice(0, blockMatch.index) +
        blockMatch[1] + newSettings + blockMatch[3] +
        pbxContents.slice(blockMatch.index + blockMatch[0].length);
}

export function removeSwiftFileFromPbxproj(
    pbxContents: string,
    fileName: string
): string | null {
    const fileRefId = findFileReferenceId(pbxContents, fileName);
    if (!fileRefId) { return null; }

    const buildFileId = findBuildFileId(pbxContents, fileRefId);

    let result = pbxContents;
    if (buildFileId) {
        result = removeFromSourcesBuildPhase(result, buildFileId);
        result = removeBuildFile(result, buildFileId);
    }
    result = removeFromGroup(result, fileRefId);
    result = removeFileReference(result, fileRefId);
    return result;
}

// ── Core Data Models (XCVersionGroup) ────────────────────
// A `.xcdatamodeld` bundle goes in the Sources phase, not Resources, because momc compiles it.

const DATA_MODEL_VERSION_FILE_TYPE = 'wrapper.xcdatamodel';

export interface DataModelVersion {
    id: string;
    /** Version bundle name, e.g. "MyApp.xcdatamodel". */
    name: string;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Indent used by object entries elsewhere in the file, so a new section matches its style. */
function detectSectionIndent(pbxContents: string): string {
    const startIdx = pbxContents.indexOf('/* Begin PBXFileReference section */');
    const endIdx = pbxContents.indexOf('/* End PBXFileReference section */');
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) { return '\t\t'; }
    return detectIndent(pbxContents.slice(startIdx, endIdx).split('\n').slice(1), '\t\t');
}

function formatVersionGroupEntry(
    versionGroupId: string,
    bundleName: string,
    versions: DataModelVersion[],
    currentVersionId: string | undefined,
    indent: string,
    name?: string,
    sourceTree: string = '<group>'
): string {
    const inner = indent + '\t';
    const child = inner + '\t';
    const lines = [
        `${indent}${versionGroupId} /* ${bundleName} */ = {`,
        `${inner}isa = XCVersionGroup;`,
        `${inner}children = (`,
        ...versions.map((version) => `${child}${version.id} /* ${version.name} */,`),
        `${inner});`
    ];

    const current = versions.find((version) => version.id === currentVersionId);
    if (current) {
        lines.push(`${inner}currentVersion = ${current.id} /* ${current.name} */;`);
    }
    if (name !== undefined) {
        lines.push(`${inner}name = ${formatPath(name)};`);
    }
    lines.push(
        `${inner}path = ${formatPath(bundleName)};`,
        `${inner}sourceTree = ${formatPath(sourceTree)};`,
        `${inner}versionGroupType = ${DATA_MODEL_VERSION_FILE_TYPE};`,
        `${indent}};`
    );
    return lines.join('\n') + '\n';
}

/** Offset just past the last `/* End <isa> section *\/` line, where a new section belongs. */
function findLastSectionEnd(pbxContents: string): number {
    const markerRegex = /^\/\* End [A-Za-z]+ section \*\/[ \t]*\r?\n/gm;
    let insertAt = -1;
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(pbxContents)) !== null) {
        insertAt = match.index + match[0].length;
    }
    return insertAt;
}

/** Insert an XCVersionGroup in ascending ID order, creating the section when the project has none. */
export function addVersionGroup(
    pbxContents: string,
    versionGroupId: string,
    bundleName: string,
    versions: DataModelVersion[],
    currentVersionId: string | undefined
): string {
    const indent = detectSectionIndent(pbxContents);
    const entry = formatVersionGroupEntry(versionGroupId, bundleName, versions, currentVersionId, indent);

    const section = findVersionGroupSection(pbxContents);
    if (!section) {
        // XCVersionGroup sorts last among pbxproj isa sections, so append after the final one.
        const insertAt = findLastSectionEnd(pbxContents);
        if (insertAt === -1) { return pbxContents; }
        const newSection =
            `\n${VERSION_GROUP_SECTION_BEGIN}\n${entry}${VERSION_GROUP_SECTION_END}\n`;
        return pbxContents.slice(0, insertAt) + newSection + pbxContents.slice(insertAt);
    }

    // Entries are multi-line, so order by parsed entry rather than by scanning lines for IDs.
    let insertAt = section.bodyEnd;
    for (const group of parseVersionGroups(pbxContents)) {
        if (group.id > versionGroupId) {
            insertAt = group.startIndex;
            break;
        }
    }
    return pbxContents.slice(0, insertAt) + entry + pbxContents.slice(insertAt);
}

/** Remove an XCVersionGroup entry, dropping the section markers once the last entry is gone. */
export function removeVersionGroup(pbxContents: string, versionGroupId: string): string {
    const target = parseVersionGroups(pbxContents).find((group) => group.id === versionGroupId);
    if (!target) { return pbxContents; }

    const result = pbxContents.slice(0, target.startIndex) + pbxContents.slice(target.endIndex);

    // An empty section is invalid for Xcode to round-trip, so take the markers with it.
    const emptySection = new RegExp(
        `(?:(?<=\\n)\\r?\\n)?${escapeRegExp(VERSION_GROUP_SECTION_BEGIN)}[ \\t]*\\r?\\n` +
        `${escapeRegExp(VERSION_GROUP_SECTION_END)}[ \\t]*\\r?\\n`
    );
    return result.replace(emptySection, '');
}

/** Rewrite an XCVersionGroup's versions in place, so its id, section position, and every target's PBXBuildFile, group child, and Sources entry survive. */
export function updateVersionGroupVersions(
    pbxContents: string,
    versionGroupId: string,
    versionNames: string[],
    currentVersionName: string | undefined
): string | null {
    if (versionNames.length === 0) { return null; }
    const target = parseVersionGroups(pbxContents).find((group) => group.id === versionGroupId);
    if (!target) { return null; }

    let result = pbxContents;
    for (const childId of target.childIds) {
        result = removeFileReference(result, childId);
    }

    const existingIds = collectExistingIds(result);
    const versions: DataModelVersion[] = versionNames.map((name) => {
        const id = generateUniqueId(existingIds);
        existingIds.add(id);
        return { id, name };
    });
    for (const version of versions) {
        result = addFileReference(result, version.id, version.name, DATA_MODEL_VERSION_FILE_TYPE);
    }
    const current = versions.find((version) => version.name === currentVersionName) ?? versions[0];

    // Offsets moved with the edits above, so relocate the entry before splicing.
    const fresh = parseVersionGroups(result).find((group) => group.id === versionGroupId);
    if (!fresh) { return null; }
    const bundleName = fresh.path ?? fresh.name;
    if (!bundleName) { return null; }
    // The entry's identity fields survive verbatim; only children/currentVersion change.
    const name = fresh.path !== undefined ? fresh.name : undefined;
    const entry = formatVersionGroupEntry(
        versionGroupId, bundleName, versions, current.id, detectSectionIndent(result),
        name, fresh.sourceTree ?? '<group>'
    );
    return result.slice(0, fresh.startIndex) + entry + result.slice(fresh.endIndex);
}

/** Move an XCVersionGroup's child entry to another PBXGroup, leaving every other structure alone. */
export function moveVersionGroupToGroup(
    pbxContents: string,
    versionGroupId: string,
    newGroupId: string,
    bundleName: string
): string {
    let result = removeFromGroup(pbxContents, versionGroupId);
    result = addToGroup(result, newGroupId, versionGroupId, bundleName, anyEntry);

    // The new parent group maps to the bundle's own directory, so a path that
    // carried directory components must collapse to the plain bundle name or
    // the entry would resolve to a directory that no longer exists.
    const target = parseVersionGroups(result).find((group) => group.id === versionGroupId);
    if (target && target.path !== undefined && target.path !== bundleName) {
        const entryText = result.slice(target.startIndex, target.endIndex)
            .replace(/(\bpath\s*=\s*)[^;]+;/, `$1${formatPath(bundleName)};`);
        result = result.slice(0, target.startIndex) + entryText + result.slice(target.endIndex);
    }
    return result;
}

/** Register a `.xcdatamodeld` bundle: all five structures, in one pass. */
export function addDataModelToPbxproj(
    pbxContents: string,
    bundleName: string,
    versionNames: string[],
    currentVersionName: string | undefined,
    groupId: string,
    sourcesBuildPhaseId: string
): string {
    const existingIds = collectExistingIds(pbxContents);
    const takeId = (): string => {
        const id = generateUniqueId(existingIds);
        existingIds.add(id);
        return id;
    };

    const buildFileId = takeId();
    const versionGroupId = takeId();
    const versions: DataModelVersion[] = versionNames.map((name) => ({ id: takeId(), name }));
    const currentVersion =
        versions.find((version) => version.name === currentVersionName) ?? versions[0];

    let result = pbxContents;
    // The build file's fileRef is the XCVersionGroup — the bundle has no PBXFileReference of its own.
    result = addBuildFile(result, buildFileId, versionGroupId, bundleName);
    for (const version of versions) {
        result = addFileReference(result, version.id, version.name, DATA_MODEL_VERSION_FILE_TYPE);
    }
    result = addToGroup(result, groupId, versionGroupId, bundleName, anyEntry);
    result = addToSourcesBuildPhase(result, sourcesBuildPhaseId, buildFileId, bundleName);
    result = addVersionGroup(result, versionGroupId, bundleName, versions, currentVersion?.id);
    return result;
}

/** Unregister a `.xcdatamodeld` bundle; null when the XCVersionGroup is absent, so callers can tell "nothing to do" from "removed". */
export function removeDataModelFromPbxproj(
    pbxContents: string,
    versionGroupId: string
): string | null {
    const target = parseVersionGroups(pbxContents).find((group) => group.id === versionGroupId);
    if (!target) { return null; }

    let result = pbxContents;
    // A model shared by several targets has one PBXBuildFile per target, so drain them all.
    const handled = new Set<string>();
    for (
        let buildFileId = findBuildFileId(result, versionGroupId);
        buildFileId && !handled.has(buildFileId);
        buildFileId = findBuildFileId(result, versionGroupId)
    ) {
        handled.add(buildFileId);
        result = removeFromSourcesBuildPhase(result, buildFileId);
        result = removeBuildFile(result, buildFileId);
    }
    // Drops the group child entry; the XCVersionGroup body is removed whole below.
    result = removeFromGroup(result, versionGroupId);
    result = removeVersionGroup(result, versionGroupId);
    for (const childId of target.childIds) {
        result = removeFileReference(result, childId);
    }
    return result;
}
