import type {
    DeploymentTarget,
    ProductDefinition,
    TargetOutput,
    BuildPackageSwiftOptions,
    PackageRequirement,
    SwiftPackageReference
} from '../types/interfaces';
import { PLATFORM_DECLARATIONS, INDENT } from '../types/constants';

function indent(level: number): string {
    return INDENT.repeat(level);
}

export function formatPlatformVersion(version: string): string {
    const major = Number.parseInt(String(version).split('.')[0], 10);
    if (Number.isFinite(major) && major > 0) {
        return `.v${major}`;
    }
    return `.v13`;
}

export function formatPlatforms(platforms: DeploymentTarget[]): string {
    return platforms
        .map(({ platform, version }, index) => {
            const declaration = PLATFORM_DECLARATIONS[platform] || '.iOS';
            const formattedVersion = formatPlatformVersion(version);
            const suffix = index < platforms.length - 1 ? ',' : '';
            return `${indent(2)}${declaration}(${formattedVersion})${suffix}`;
        })
        .join('\n');
}

export function formatProducts(products: ProductDefinition[]): string {
    if (products.length === 0) {
        return `${indent(2)}.library(\n${indent(3)}name: "Library",\n${indent(3)}targets: []\n${indent(2)})`;
    }
    return products
        .map((product) => {
            const targetsList = product.targets.map((item) => `"${item}"`).join(', ');
            return [
                `${indent(2)}${product.type}(`,
                `${indent(3)}name: "${product.name}",`,
                `${indent(3)}targets: [${targetsList}]`,
                `${indent(2)})`
            ].join('\n');
        })
        .join(',\n');
}

export function formatRemotePackageRequirement(requirement?: PackageRequirement | null): string | null {
    if (!requirement) {
        return null;
    }
    const kind = requirement.kind;
    if (!kind) {
        return null;
    }
    const versionOrMinimum = requirement.version || requirement.minimumVersion;
    switch (kind) {
        case 'upToNextMajorVersion': {
            if (versionOrMinimum) {
                return `.upToNextMajor(from: "${versionOrMinimum}")`;
            }
            break;
        }
        case 'upToNextMinorVersion': {
            if (versionOrMinimum) {
                return `.upToNextMinor(from: "${versionOrMinimum}")`;
            }
            break;
        }
        case 'exactVersion': {
            if (versionOrMinimum) {
                return `.exact("${versionOrMinimum}")`;
            }
            break;
        }
        case 'branch': {
            if (requirement.branch) {
                return `.branch("${requirement.branch}")`;
            }
            break;
        }
        case 'revision': {
            if (requirement.revision) {
                return `.revision("${requirement.revision}")`;
            }
            break;
        }
        case 'versionRange': {
            if (requirement.minimumVersion && requirement.maximumVersion) {
                return `"${requirement.minimumVersion}"..<"${requirement.maximumVersion}"`;
            }
            break;
        }
        case 'range': {
            if (requirement.lowerBound && requirement.upperBound) {
                return `"${requirement.lowerBound}"..<"${requirement.upperBound}"`;
            }
            break;
        }
        default: {
            break;
        }
    }
    const fallbackVersion = requirement.minimumVersion || requirement.version;
    if (fallbackVersion) {
        return `.upToNextMajor(from: "${fallbackVersion}")`;
    }
    return null;
}

export function formatPackageDependencyEntry(reference: SwiftPackageReference): string | null {
    if (reference.type === 'local') {
        const pathValue =
            reference.path && reference.path.length > 0 ? reference.path : `./${reference.name}`;
        return `.package(path: "${pathValue}")`;
    }

    const url = reference.url || '';
    const requirement = reference.requirement || ({} as PackageRequirement);
    const formattedRequirement = formatRemotePackageRequirement(requirement);
    if (formattedRequirement) {
        return `.package(url: "${url}", ${formattedRequirement})`;
    }
    return `.package(url: "${url}")`;
}

function formatPackageDependencies(dependencies: string[]): string {
    return dependencies.map((dependency) => `${indent(2)}${dependency}`).join(',\n');
}

function formatTargetArray(label: string, items: string[], indentLevel: number): string {
    if (items.length === 1) {
        return `${indent(indentLevel)}${label}: [${items[0]}]`;
    }
    const itemLines = items.map((item, i) => {
        const suffix = i < items.length - 1 ? ',' : '';
        return `${indent(indentLevel + 1)}${item}${suffix}`;
    }).join('\n');
    return `${indent(indentLevel)}${label}: [\n${itemLines}\n${indent(indentLevel)}]`;
}

export function formatTargets(targets: TargetOutput[]): string {
    if (targets.length === 0) {
        return `${indent(2)}.target(\n${indent(3)}name: "Placeholder",\n${indent(3)}path: "Sources"\n${indent(2)})`;
    }
    return targets
        .map((target) => {
            const properties: string[] = [`${indent(3)}name: "${target.name}"`];

            if (target.dependencies && target.dependencies.length > 0) {
                if (target.dependencies.length === 1) {
                    properties.push(`${indent(3)}dependencies: [${target.dependencies[0]}]`);
                } else {
                    const depLines = target.dependencies.map((dep, i) => {
                        const suffix = i < target.dependencies!.length - 1 ? ',' : '';
                        return `${indent(4)}${dep}${suffix}`;
                    }).join('\n');
                    properties.push(`${indent(3)}dependencies: [\n${depLines}\n${indent(3)}]`);
                }
            }

            properties.push(`${indent(3)}path: "${target.path}"`);

            if (target.exclude && target.exclude.length > 0) {
                const excludeItems = target.exclude.map((e) => `"${e}"`);
                properties.push(formatTargetArray('exclude', excludeItems, 3));
            }

            if (target.resources && target.resources.length > 0) {
                const resourceItems = target.resources.map(
                    (r) => `${r.type}("${r.path}")`
                );
                properties.push(formatTargetArray('resources', resourceItems, 3));
            }

            if (target.swiftSettings && target.swiftSettings.length > 0) {
                properties.push(formatTargetArray('swiftSettings', target.swiftSettings, 3));
            }

            if (target.cSettings && target.cSettings.length > 0) {
                properties.push(formatTargetArray('cSettings', target.cSettings, 3));
            }

            if (target.linkerSettings && target.linkerSettings.length > 0) {
                properties.push(formatTargetArray('linkerSettings', target.linkerSettings, 3));
            }

            const lines = [`${indent(2)}${target.spmType}(`];
            properties.forEach((property, index) => {
                const suffix = index === properties.length - 1 ? '' : ',';
                lines.push(`${property}${suffix}`);
            });
            lines.push(`${indent(2)})`);
            return lines.join('\n');
        })
        .join(',\n');
}

export function buildPackageSwift({
    packageName,
    swiftVersion,
    platforms,
    products,
    dependencies,
    targets,
    defaultLocalization,
    preamble
}: BuildPackageSwiftOptions): string {
    const platformsSection = formatPlatforms(platforms);
    const productsSection = formatProducts(products);
    const dependenciesSection =
        dependencies && dependencies.length > 0 ? formatPackageDependencies(dependencies) : '';
    const targetsSection = formatTargets(targets);
    const defaultLocalizationLine = defaultLocalization ? `
    defaultLocalization: "${defaultLocalization}",` : '';
    return `// swift-tools-version: ${swiftVersion}
// The swift-tools-version declares the minimum version of Swift required to build this package.
// Managed by VSXcode — changes will be overwritten

import PackageDescription
${preamble ? `\n${preamble}\n` : ''}
let package = Package(
    name: "${packageName}",${defaultLocalizationLine}
    platforms: [
${platformsSection}
    ],
    products: [
${productsSection}
    ],${
        dependenciesSection
            ? `
    dependencies: [
${dependenciesSection}
    ],`
            : ''
    }
    targets: [
${targetsSection}
    ]
)
`;
}
