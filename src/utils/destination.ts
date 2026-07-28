import * as os from 'os';
import * as path from 'path';
import type { BuildTaskConfig, DestinationType } from '../types/interfaces';

const DERIVED_DATA_SEGMENTS = ['Library', 'Developer', 'VSCode', 'DerivedData'];

/** Absolute path to the root holding one DerivedData tree per scheme. */
export function derivedDataBasePath(): string {
    return path.join(os.homedir(), ...DERIVED_DATA_SEGMENTS);
}

/** Absolute path to one scheme's DerivedData tree. */
export function derivedDataPathForScheme(schemeName: string): string {
    return path.join(derivedDataBasePath(), schemeName);
}

/** `$HOME/...` form of a scheme's DerivedData tree for shell command lines. */
export function derivedDataShellPathForScheme(schemeName: string): string {
    return `$HOME/${DERIVED_DATA_SEGMENTS.join('/')}/${schemeName}`;
}

/**
 * Resolve the destination type for a config. Prefers the explicit
 * `destinationType`; falls back to the legacy `isPhysicalDevice` boolean so
 * configs persisted before macOS support keep working with no migration.
 */
export function getDestinationType(config: BuildTaskConfig): DestinationType {
    if (config.destinationType) {
        return config.destinationType;
    }
    return config.isPhysicalDevice ? 'device' : 'simulator';
}

/**
 * The product subdirectory under `Build/Products` for a destination. macOS
 * builds have no SDK suffix; iOS device/simulator builds do.
 */
export function productDirForDestination(dest: DestinationType): string {
    switch (dest) {
        case 'device':
            return 'Debug-iphoneos';
        case 'simulator':
            return 'Debug-iphonesimulator';
        case 'mac':
            return 'Debug';
    }
}

/**
 * The `-sdk`/`-destination` tokens for an xcodebuild invocation. macOS is
 * destination-only (passing `-sdk` alongside the macOS destination conflicts);
 * iOS passes both an SDK and a UDID-pinned destination.
 */
export function xcodebuildDestinationFlags(config: BuildTaskConfig): string[] {
    const dest = getDestinationType(config);
    if (dest === 'mac') {
        return [`-destination 'platform=macOS'`, '-allowProvisioningUpdates'];
    }
    const sdk = dest === 'device' ? 'iphoneos' : 'iphonesimulator';
    const udid = config.simulatorUdid || config.simulatorDevice;
    const flags = [`-sdk ${sdk}`, `-destination "id=${udid}"`];
    if (dest === 'device') {
        flags.push('-allowProvisioningUpdates');
    }
    return flags;
}

/**
 * Absolute path to the built `.app` bundle in the extension's DerivedData.
 */
export function builtAppPath(config: BuildTaskConfig): string {
    const productDir = productDirForDestination(getDestinationType(config));
    return path.join(
        derivedDataPathForScheme(config.schemeName),
        'Build', 'Products', productDir, `${config.productName}.app`
    );
}
