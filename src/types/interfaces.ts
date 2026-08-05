export type PlatformName = 'iOS' | 'macOS' | 'tvOS' | 'watchOS';
export type PlatformDeclaration = '.iOS' | '.macOS' | '.tvOS' | '.watchOS';
export type ProductType = '.library' | '.executable';
export type TargetSPMType = '.target' | '.testTarget';

// Where a build/run/debug targets: an iOS simulator, a physical iOS device, or the host Mac.
export type DestinationType = 'simulator' | 'device' | 'mac';

export interface DeploymentTarget {
    platform: PlatformName;
    version: string;
}

export interface ExtractObjectBodyResult {
    body: string;
    endIndex: number;
}

export type PackageRequirement = Record<string, string>;

export interface NativeTarget {
    name: string;
    productName: string;
    productType: string;
    packageProductDependencyIds: string[];
    buildConfigurationListId: string;
    fileSystemSynchronizedGroupIds: string[];
}

export interface BasePackageReference {
    id: string;
    name: string;
}

export interface RemoteSwiftPackageReference extends BasePackageReference {
    type: 'remote';
    url?: string;
    requirement?: PackageRequirement;
}

export interface LocalSwiftPackageReference extends BasePackageReference {
    type: 'local';
    path: string;
}

export type SwiftPackageReference = RemoteSwiftPackageReference | LocalSwiftPackageReference;

export interface SwiftPackageProductDependency {
    id: string;
    productName: string;
    packageRef: string | null;
    packageName: string | null;
}

export interface ProductDefinition {
    type: ProductType;
    name: string;
    targets: string[];
}

export interface TargetDefinition {
    name: string;
    productName: string;
    productType: string;
    spmType: TargetSPMType;
    path: string;
    isTest: boolean;
    dependencies: string[];
}

export interface TargetOutput {
    spmType: TargetSPMType;
    name: string;
    path: string;
    dependencies?: string[];
    resources?: ResourceOutput[];
    swiftSettings?: string[];
    linkerSettings?: string[];
    cSettings?: string[];
    exclude?: string[];
}

export interface BuildPackageSwiftOptions {
    packageName: string;
    swiftVersion: string;
    platforms: DeploymentTarget[];
    products: ProductDefinition[];
    dependencies: string[];
    targets: TargetOutput[];
    defaultLocalization?: string;
}

export interface BuildSettings {
    configurationName: string;
    targetId: string | null;
    swiftVersion?: string;
    strictConcurrency?: string;
    swiftActiveCompilationConditions?: string[];
    otherSwiftFlags?: string[];
    gccPreprocessorDefinitions?: string[];
    headerSearchPaths?: string[];
    bundleIdentifier?: string;
    productName?: string;
    supportedPlatforms?: string;
    sdkRoot?: string;
    macosxDeploymentTarget?: string;
}

export interface SwiftSettingsOutput {
    type: '.define' | '.unsafeFlags' | '.enableUpcomingFeature';
    value: string | string[];
    condition?: string;
}

export interface LinkerSettingsOutput {
    type: '.linkedFramework' | '.linkedLibrary';
    value: string;
}

export interface ResourceOutput {
    type: '.process' | '.copy';
    path: string;
}

export interface TargetBuildPhases {
    sourcesBuildPhaseId?: string;
    frameworksBuildPhaseId?: string;
    resourcesBuildPhaseId?: string;
}

export interface PBXBuildFile {
    id: string;
    fileRef: string;
}

export interface PBXFileReference {
    id: string;
    name: string;
    path: string;
    sourceTree?: string;
    lastKnownFileType?: string;
}

export interface TargetDependencyInfo {
    targetId: string;
    targetName: string;
}

export interface BuildTaskConfig {
    projectFile: string;
    schemeName: string;
    targetName: string;
    productName: string;
    simulatorDevice: string;
    simulatorUdid: string;
    isPhysicalDevice?: boolean;
    deviceIdentifier?: string;
    // Authoritative destination discriminator. When absent (legacy stored
    // configs), derive via getDestinationType() from isPhysicalDevice.
    destinationType?: DestinationType;
    // Build-time only: suffixes PRODUCT_BUNDLE_IDENTIFIER via an xcodebuild
    // override so the dev app installs beside the shipping one. Never writes pbxproj.
    devBundleId?: boolean;
}

export interface SwiftFormatConfig {
    enabled: boolean;
    path: string;
    formatOnSave: boolean;
    lintMode: boolean;
    disabledRules: string[];
    enabledRules: string[];
    indentation: 'spaces' | 'tabs';
    indentationCount: number;
    lineLength: number;
    maximumBlankLines: number;
    respectsExistingLineBreaks: boolean;
    lineBreakBeforeControlFlowKeywords: boolean;
    lineBreakBeforeEachArgument: boolean;
    lineBreakBeforeEachGenericRequirement: boolean;
    lineBreakAroundMultilineExpressionChainComponents: boolean;
    lineBreakBeforeSwitchCaseBody: boolean;
    lineBreakBetweenDeclarationAttributes: boolean;
    indentConditionalCompilationBlocks: boolean;
    indentSwitchCaseLabels: boolean;
    fileScopedDeclarationPrivacy: 'private' | 'fileprivate';
    multiElementCollectionTrailingCommas: boolean;
    prioritizeKeepingFunctionOutputTogether: boolean;
    spacesAroundRangeFormationOperators: boolean;
    spacesBeforeEndOfLineComments: number;
    reflowMultilineStringLiterals: 'never' | 'always';
}

export interface SwiftFormatRule {
    identifier: string;
    enabled: boolean;
    isDefault: boolean;
}
