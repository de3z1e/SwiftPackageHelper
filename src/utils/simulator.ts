import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import type { ExecFileOptionsWithStringEncoding } from 'child_process';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isXcodeFirstLaunchComplete } from './version';

const execFile = promisify(execFileCallback) as (
    file: string,
    args?: ReadonlyArray<string>,
    options?: ExecFileOptionsWithStringEncoding
) => Promise<{ stdout: string; stderr: string }>;

export interface SimulatorDevice {
    name: string;
    udid: string;
    state: string;
    runtime: string;
}

export interface PhysicalDevice {
    name: string;
    udid: string;
    deviceIdentifier: string;
    osVersion: string;
    connectionType: string;
    productType: string;
    osBuildVersion: string;
}

export interface MacDestination {
    name: string; // ComputerName, e.g. "My MacBook Pro"
    arch: string; // arm64 | x86_64
}

interface SimctlDevice {
    name: string;
    udid: string;
    state: string;
    isAvailable: boolean;
}

interface SimctlOutput {
    devices: Record<string, SimctlDevice[]>;
}

export async function listAvailableSimulators(): Promise<SimulatorDevice[]> {
    // simctl blocks indefinitely until Xcode first-launch completes — gate rather than hang.
    if (!(await isXcodeFirstLaunchComplete())) { return []; }
    try {
        const { stdout } = await execFile(
            'xcrun',
            ['simctl', 'list', 'devices', 'available', '-j'],
            { encoding: 'utf8' }
        );
        const parsed: SimctlOutput = JSON.parse(stdout);
        const devices: SimulatorDevice[] = [];

        for (const [runtime, deviceList] of Object.entries(parsed.devices)) {
            for (const device of deviceList) {
                if (device.isAvailable) {
                    devices.push({
                        name: device.name,
                        udid: device.udid,
                        state: device.state,
                        runtime
                    });
                }
            }
        }

        return devices
            .filter((d) => d.runtime.includes('iOS') || d.runtime.includes('iphone'))
            .sort((a, b) => {
                const aBooted = a.state === 'Booted' ? 0 : 1;
                const bBooted = b.state === 'Booted' ? 0 : 1;
                if (aBooted !== bBooted) { return aBooted - bBooted; }
                const parseVersion = (runtime: string): number[] => {
                    const match = runtime.match(/(\d+)-(\d+)(?:-(\d+))?$/);
                    return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
                };
                const aVer = parseVersion(a.runtime);
                const bVer = parseVersion(b.runtime);
                for (let i = 0; i < 3; i++) {
                    if (bVer[i] !== aVer[i]) { return bVer[i] - aVer[i]; }
                }
                return 0;
            });
    } catch {
        return [];
    }
}

/**
 * Describe the host Mac as a run/debug destination ("My Mac"). Returns null on
 * non-macOS hosts. The arch is display-only; Debug builds compile native-arch
 * via ONLY_ACTIVE_ARCH, so it is not pinned into the xcodebuild destination.
 */
export async function getMyMacDestination(): Promise<MacDestination | null> {
    if (process.platform !== 'darwin') {
        return null;
    }
    try {
        const [nameResult, archResult] = await Promise.all([
            execFile('scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }),
            execFile('uname', ['-m'], { encoding: 'utf8' }),
        ]);
        return {
            name: nameResult.stdout.trim() || 'My Mac',
            arch: archResult.stdout.trim() || 'arm64',
        };
    } catch {
        return { name: 'My Mac', arch: 'arm64' };
    }
}

export async function devicectlInstall(deviceId: string, appPath: string): Promise<void> {
    await execFile(
        'xcrun',
        ['devicectl', 'device', 'install', 'app', '--device', deviceId, appPath],
        { encoding: 'utf8' }
    );
}

export async function devicectlTerminate(deviceId: string, pid: number): Promise<void> {
    try {
        await execFile(
            'xcrun',
            ['devicectl', 'device', 'process', 'terminate', '--device', deviceId, '--pid', String(pid)],
            { encoding: 'utf8' }
        );
    } catch {
        // Best-effort: app may already have exited
    }
}

export async function checkDeviceReady(deviceId: string): Promise<{ ready: boolean; message?: string }> {
    try {
        const { stdout, stderr } = await execFile(
            'xcrun',
            ['lldb', '--batch', '-o', 'platform select remote-ios', '-o', `device select ${deviceId}`, '-o', 'quit'],
            { encoding: 'utf8' }
        );
        const output = stdout + stderr;
        if (output.includes('needs to be unlocked')) {
            return { ready: false, message: 'Device needs to be unlocked.' };
        }
        return { ready: true };
    } catch (error) {
        const message = String((error as { stderr?: string }).stderr || error);
        if (message.includes('needs to be unlocked')) {
            return { ready: false, message: 'Device needs to be unlocked.' };
        }
        // Other errors — let the debug session handle them
        return { ready: true };
    }
}

export async function listPhysicalDevices(): Promise<PhysicalDevice[]> {
    // devicectl also wedges until first-launch completes — same gate.
    if (!(await isXcodeFirstLaunchComplete())) { return []; }
    const tmpFile = path.join(os.tmpdir(), `sph-devices-${Date.now()}.json`);
    try {
        await execFile(
            'xcrun',
            ['devicectl', 'list', 'devices', '--json-output', tmpFile],
            { encoding: 'utf8' }
        );
        const content = await fsp.readFile(tmpFile, 'utf8');
        const parsed = JSON.parse(content);
        const devices: PhysicalDevice[] = [];

        for (const device of parsed.result?.devices || []) {
            const platform = device.hardwareProperties?.platform;
            const pairingState = device.connectionProperties?.pairingState;
            const transportType = device.connectionProperties?.transportType;
            // Devices with no transport are paired but unreachable — can't build/run to them.
            if (platform === 'iOS' && pairingState === 'paired' && transportType) {
                devices.push({
                    name: device.deviceProperties?.name || 'Unknown Device',
                    udid: device.hardwareProperties?.udid || device.identifier || '',
                    deviceIdentifier: device.identifier || '',
                    osVersion: device.deviceProperties?.osVersionNumber || '',
                    connectionType: transportType,
                    productType: device.hardwareProperties?.productType || '',
                    osBuildVersion: device.deviceProperties?.osBuildUpdate || '',
                });
            }
        }

        return devices;
    } catch {
        return [];
    } finally {
        try { await fsp.unlink(tmpFile); } catch { /* ignore cleanup errors */ }
    }
}

export interface SimulatorAppProcess {
    pid: number;
    /** Raw ps STAT field, e.g. "Ts" (stopped) or "SXs" (traced). */
    stat: string;
}

/**
 * A simulator app is an ordinary host process, so matching by executable *name*
 * would also hit that app on any other booted simulator. Both forms below stay
 * device-scoped because simulator bundle paths embed the device UDID.
 */
export interface SimulatorAppQuery {
    udid: string;
    productName: string;
    /** Exact executable path when known — strictest match. */
    executablePath?: string;
}

function matchesSimulatorApp(command: string, query: SimulatorAppQuery): boolean {
    // Device scope gates every form, so no widening below can ever reach another
    // simulator. Bundle paths look like .../Devices/<udid>/data/.../<Product>.app.
    if (!command.includes(`/${query.udid}/`)) { return false; }
    if (query.executablePath
        && (command === query.executablePath || command.startsWith(`${query.executablePath} `))) {
        return true;
    }
    // Union rather than either/or: if get_app_container ever reported a path that
    // didn't match argv[0], an exclusive branch would silently burn the whole
    // timeout waiting for a match that can never arrive.
    // Locate the suffix rather than splitting on spaces — a product name may
    // contain them, and argv beyond argv[0] may follow.
    const suffix = `/${query.productName}.app/${query.productName}`;
    const at = command.indexOf(suffix);
    if (at < 0) { return false; }
    const after = at + suffix.length;
    return after === command.length || command[after] === ' ';
}

export async function listSimulatorAppProcesses(query: SimulatorAppQuery): Promise<SimulatorAppProcess[]> {
    let stdout: string;
    try {
        ({ stdout } = await execFile(
            'ps',
            ['-Ao', 'pid=,stat=,command='],
            { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        ));
    } catch {
        return [];
    }
    const processes: SimulatorAppProcess[] = [];
    for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!match) { continue; }
        const [, pid, stat, command] = match;
        if (matchesSimulatorApp(command, query)) {
            processes.push({ pid: Number(pid), stat });
        }
    }
    return processes;
}

/**
 * Polling can only miss a process the caller didn't suspend — `simctl launch
 * --wait-for-debugger` holds it indefinitely. `excludePids` disambiguates a stopped
 * same-device orphan, which `simctl terminate` cannot reap (SIGTERM stays pending).
 */
export async function waitForNewSimulatorAppProcess(
    query: SimulatorAppQuery,
    excludePids: ReadonlySet<number>,
    options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<SimulatorAppProcess | undefined> {
    const timeoutMs = options.timeoutMs ?? 60000;
    const intervalMs = options.intervalMs ?? 150;
    const deadline = Date.now() + timeoutMs;
    // Each poll forks a full `ps -A`; widen the gap so a cold boot that takes the
    // whole timeout costs ~70 of them rather than ~400. The sleep is abort-aware,
    // so a longer gap never delays cancellation.
    let delayMs = intervalMs;
    while (Date.now() < deadline) {
        if (options.signal?.aborted) { return undefined; }
        const candidates = (await listSimulatorAppProcesses(query))
            .filter((p) => !excludePids.has(p.pid));
        if (candidates.length > 0) {
            // A stopped process is the one waiting for us; prefer it if several match.
            return candidates.find((p) => p.stat.startsWith('T')) ?? candidates[0];
        }
        await sleepUntilAborted(delayMs, options.signal);
        delayMs = Math.min(delayMs * 1.5, 1000);
    }
    return undefined;
}

function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
    // An already-aborted signal never fires the event, so check before waiting.
    if (signal?.aborted) { return Promise.resolve(); }
    return new Promise<void>((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}

/**
 * Check if Xcode has cached device symbols for the given physical device.
 * Xcode stores extracted shared cache symbols in:
 *   ~/Library/Developer/Xcode/iOS DeviceSupport/<productType> <osVersion> (<buildVersion>)/Symbols/
 * Returns the Symbols path if found and finalized, or undefined if missing.
 */
export async function findDeviceSymbols(device: PhysicalDevice): Promise<string | undefined> {
    if (!device.productType || !device.osVersion || !device.osBuildVersion) {
        return undefined;
    }
    const supportDir = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'iOS DeviceSupport');
    const expectedName = `${device.productType} ${device.osVersion} (${device.osBuildVersion})`;
    const symbolsPath = path.join(supportDir, expectedName, 'Symbols');
    try {
        await fsp.access(path.join(supportDir, expectedName, '.finalized'));
        await fsp.access(symbolsPath);
        return symbolsPath;
    } catch {
        return undefined;
    }
}
