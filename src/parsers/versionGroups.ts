import { cleanup } from '../utils/version';
import { extractObjectBody } from './base';

export const VERSION_GROUP_SECTION_BEGIN = '/* Begin XCVersionGroup section */';
export const VERSION_GROUP_SECTION_END = '/* End XCVersionGroup section */';

/** The pbxproj node for a `.xcdatamodeld`: it stands in for the bundle wherever a PBXFileReference normally would, and its children are the `.xcdatamodel` version refs. */
export interface XCVersionGroupInfo {
    id: string;
    /** On-disk bundle name, e.g. "MyApp.xcdatamodeld". */
    path?: string;
    name?: string;
    /** PBXFileReference ids of the `.xcdatamodel` versions inside the bundle. */
    childIds: string[];
    currentVersionId?: string;
    /** Raw sourceTree value, e.g. "<group>" or "SOURCE_ROOT". */
    sourceTree?: string;
    /** Offset of the entry's first character in the source, at the start of its line. */
    startIndex: number;
    /** Offset just past the entry's terminating `};` and line break. */
    endIndex: number;
}

export interface VersionGroupSection {
    /** Offset of the `/* Begin ... *\/` marker. */
    beginIndex: number;
    /** Offset just past the begin marker's line break — where entries start. */
    bodyStart: number;
    /** Offset of the `/* End ... *\/` marker — where entries stop. */
    bodyEnd: number;
}

export function findVersionGroupSection(pbxContents: string): VersionGroupSection | null {
    const beginIndex = pbxContents.indexOf(VERSION_GROUP_SECTION_BEGIN);
    if (beginIndex === -1) { return null; }
    const bodyEnd = pbxContents.indexOf(VERSION_GROUP_SECTION_END, beginIndex);
    if (bodyEnd === -1) { return null; }

    const newlineIndex = pbxContents.indexOf('\n', beginIndex);
    const bodyStart = newlineIndex === -1 || newlineIndex > bodyEnd
        ? beginIndex + VERSION_GROUP_SECTION_BEGIN.length
        : newlineIndex + 1;

    return { beginIndex, bodyStart, bodyEnd };
}

/** Offset just past an entry's closing `};` plus any trailing line break. */
function consumeEntryTail(pbxContents: string, closingBraceEnd: number): number {
    let index = closingBraceEnd;
    if (pbxContents[index] === ';') { index += 1; }
    while (pbxContents[index] === ' ' || pbxContents[index] === '\t') { index += 1; }
    if (pbxContents[index] === '\r') { index += 1; }
    if (pbxContents[index] === '\n') { index += 1; }
    return index;
}

/** Every XCVersionGroup in the file, in document order. */
export function parseVersionGroups(pbxContents: string): XCVersionGroupInfo[] {
    const section = findVersionGroupSection(pbxContents);
    if (!section) { return []; }

    const groups: XCVersionGroupInfo[] = [];
    const entryRegex =
        /^[\t ]*([A-F0-9]{24})\s*(?:\/\*[^*]*\*\/\s*)?=\s*\{[^}]*isa\s*=\s*XCVersionGroup;/gm;
    entryRegex.lastIndex = section.bodyStart;

    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(pbxContents)) !== null) {
        if (match.index >= section.bodyEnd) { break; }

        const extracted = extractObjectBody(pbxContents, match.index);
        if (!extracted) { break; }
        const body = extracted.body;

        const childIds: string[] = [];
        const childrenMatch = /children\s*=\s*\(([\s\S]*?)\);/.exec(body);
        if (childrenMatch) {
            const childIdRegex = /([A-F0-9]{24})/g;
            let childMatch: RegExpExecArray | null;
            while ((childMatch = childIdRegex.exec(childrenMatch[1])) !== null) {
                childIds.push(childMatch[1]);
            }
        }

        const currentVersionMatch = /\bcurrentVersion\s*=\s*([A-F0-9]{24})/.exec(body);
        const nameMatch = /\bname\s*=\s*([^;]+);/.exec(body);
        const pathMatch = /\bpath\s*=\s*([^;]+);/.exec(body);
        const sourceTreeMatch = /\bsourceTree\s*=\s*([^;]+);/.exec(body);

        groups.push({
            id: match[1],
            name: nameMatch ? cleanup(nameMatch[1]) : undefined,
            path: pathMatch ? cleanup(pathMatch[1]) : undefined,
            childIds,
            currentVersionId: currentVersionMatch ? currentVersionMatch[1] : undefined,
            sourceTree: sourceTreeMatch ? cleanup(sourceTreeMatch[1]) : undefined,
            startIndex: match.index,
            endIndex: consumeEntryTail(pbxContents, extracted.endIndex)
        });

        // Resume past this entry so nested child lines are never read as entries.
        entryRegex.lastIndex = extracted.endIndex;
    }

    return groups;
}

/** The bundle name an XCVersionGroup refers to on disk, as a path relative to its parent group. */
export function versionGroupBundleName(group: XCVersionGroupInfo): string | undefined {
    return group.path ?? group.name;
}

/** Just the bundle's directory name, for comparing against what's on disk. */
export function versionGroupBaseName(group: XCVersionGroupInfo): string | undefined {
    const bundleName = versionGroupBundleName(group);
    return bundleName ? bundleName.split('/').filter((s) => s.length > 0).pop() : undefined;
}
