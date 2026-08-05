import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { promisify } from 'util';
import type { BuildTaskConfig } from '../types/interfaces';
import { parseNativeTargets, isTestTarget } from '../parsers/targets';
import { determineTargetPath } from '../utils/path';
import { devBundleIdOverrideArgs } from '../utils/bundleId';
import { derivedDataBasePath, derivedDataShellPathForScheme, getDestinationType, xcodebuildDestinationFlags } from '../utils/destination';

const execFile = promisify(cp.execFile);
const DERIVED_DATA_BASE = derivedDataBasePath();

interface TestTargetInfo {
    name: string;
    absolutePath: string;
}

interface FailureDetail {
    message: string;
    filePath: string;
    line: number;
}

interface XccovFunction {
    name: string;
    lineNumber: number;
    executionCount: number;
}

interface XccovFile {
    path: string;
    coveredLines: number;
    executableLines: number;
    functions?: XccovFunction[];
}

interface XccovReport {
    targets: Array<{
        name: string;
        files: XccovFile[];
    }>;
}

export class XCTestController implements vscode.Disposable {
    private controller: vscode.TestController;
    private testTargets: TestTargetInfo[] = [];
    private coverageReport: XccovReport | undefined;
    private coverageResultPath: string | undefined;
    private activeSpawns = 0;

    /** True while a test build/run child process is alive. */
    get isBusy(): boolean {
        return this.activeSpawns > 0;
    }

    constructor(
        private workspaceState: vscode.Memento,
        private rootPath: string
    ) {
        this.controller = vscode.tests.createTestController('vsxcode-xctest', 'Xcode Tests');

        this.controller.createRunProfile(
            'Run',
            vscode.TestRunProfileKind.Run,
            (request, token) => this.runHandler(request, token),
            true
        );

        this.controller.createRunProfile(
            'Debug',
            vscode.TestRunProfileKind.Debug,
            (request, token) => this.debugHandler(request, token),
            true
        );

        const coverageProfile = this.controller.createRunProfile(
            'Run with Coverage',
            vscode.TestRunProfileKind.Coverage,
            (request, token) => this.runHandler(request, token, { coverage: true }),
            true
        );
        coverageProfile.loadDetailedCoverage = (_run, fileCoverage, _token) => {
            return this.getDetailedCoverage(fileCoverage);
        };

        this.controller.resolveHandler = async (item) => {
            if (!item) {
                await this.discoverTests();
            }
        };

        this.controller.refreshHandler = async () => {
            this.controller.items.replace([]);
            await this.discoverTests();
        };

    }

    refresh(): void {
        this.testTargets = [];
        this.controller.items.replace([]);
        this.discoverTests();
    }

    dispose(): void {
        this.controller.dispose();
    }

    // ── Test discovery ───────────────────────────────────────────

    private async discoverTests(): Promise<void> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) { return; }

        this.testTargets = this.loadTestTargets(config);

        for (const target of this.testTargets) {
            this.scanDirectory(target.name, target.absolutePath);
        }
    }

    private scanDirectory(targetName: string, dirPath: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                this.scanDirectory(targetName, fullPath);
            } else if (entry.name.endsWith('.swift')) {
                this.parseTestFile(targetName, fullPath);
            }
        }
    }

    private parseTestFile(targetName: string, filePath: string): void {
        let content: string;
        try {
            content = fs.readFileSync(filePath, 'utf8');
        } catch {
            return;
        }

        const uri = vscode.Uri.file(filePath);
        const classRegex = /(?:(?:public|internal|open)\s+)?(?:final\s+)?class\s+(\w+)\s*:\s*XCTestCase/g;
        let classMatch: RegExpExecArray | null;
        const classPositions: { className: string; startIndex: number }[] = [];

        while ((classMatch = classRegex.exec(content)) !== null) {
            classPositions.push({ className: classMatch[1], startIndex: classMatch.index });
        }

        for (let i = 0; i < classPositions.length; i++) {
            const { className, startIndex } = classPositions[i];
            const classLine = content.substring(0, startIndex).split('\n').length - 1;

            const classItem = this.controller.createTestItem(
                `${targetName}/${className}`, className, uri
            );
            classItem.range = new vscode.Range(classLine, 0, classLine, 0);
            this.controller.items.add(classItem);

            const endIndex = i + 1 < classPositions.length
                ? classPositions[i + 1].startIndex
                : content.length;
            const classBody = content.slice(startIndex, endIndex);
            const methodRegex = /func\s+(test\w+)\s*\(\s*\)/g;
            let methodMatch: RegExpExecArray | null;

            while ((methodMatch = methodRegex.exec(classBody)) !== null) {
                const methodOffset = startIndex + methodMatch.index;
                const methodLine = content.substring(0, methodOffset).split('\n').length - 1;

                const methodItem = this.controller.createTestItem(
                    `${targetName}/${className}/${methodMatch[1]}`,
                    `${methodMatch[1]}()`,
                    uri
                );
                methodItem.range = new vscode.Range(methodLine, 0, methodLine, 0);
                classItem.children.add(methodItem);
            }
        }
    }

    // ── Test execution ───────────────────────────────────────────

    private async runHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken,
        options?: { coverage?: boolean }
    ): Promise<void> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
            vscode.window.showErrorMessage('No build configuration. Configure via the VSXcode sidebar.');
            return;
        }

        const run = this.controller.createTestRun(request);
        const itemsToRun = request.include || this.getAllTopLevelItems();

        for (const item of itemsToRun) {
            this.enqueueAll(run, item);
        }

        const includeFilters = itemsToRun.map(item => item.id);
        const excludeFilters = request.exclude
            ? request.exclude.map(item => item.id)
            : [];

        const leafItems = this.collectLeafItems(itemsToRun);
        const commandLine = this.buildCommand(config, includeFilters, excludeFilters, options);
        const reportedItems = await this.executeAndParse(run, commandLine, token);

        // Mark enqueued items that never received results as skipped
        for (const item of leafItems) {
            if (!reportedItems.has(item.id)) {
                run.skipped(item);
            }
        }

        if (options?.coverage) {
            await this.loadCoverageResults(run);
        }

        run.end();
    }

    private async debugHandler(
        request: vscode.TestRunRequest,
        token: vscode.CancellationToken
    ): Promise<void> {
        const config = this.workspaceState.get<BuildTaskConfig>('buildTaskConfig');
        if (!config) {
            vscode.window.showErrorMessage('No build configuration. Configure via the VSXcode sidebar.');
            return;
        }

        const run = this.controller.createTestRun(request);
        const itemsToRun = request.include || this.getAllTopLevelItems();

        for (const item of itemsToRun) {
            this.enqueueAll(run, item);
        }

        const includeFilters = itemsToRun.map(item => item.id);
        const excludeFilters = request.exclude
            ? request.exclude.map(item => item.id)
            : [];

        // 1. Build for testing
        const buildCmd = this.buildXcodebuildBase(config);
        const filterArgs = this.buildFilterArgs(includeFilters, excludeFilters);
        const buildForTestingCmd = `${buildCmd} build-for-testing ${filterArgs} 2>&1`;

        run.appendOutput('Building for testing...\r\n');
        this.activeSpawns++;
        const buildExitCode = await new Promise<number>((resolve) => {
            let settled = false;
            const settle = (code: number) => {
                if (settled) { return; }
                settled = true;
                this.activeSpawns--;
                resolve(code);
            };
            const proc = cp.spawn('/bin/zsh', ['-c', buildForTestingCmd], {
                cwd: this.rootPath,
                env: process.env,
            });
            proc.stdout?.on('data', (data: Buffer) => {
                run.appendOutput(data.toString().replace(/\r?\n/g, '\r\n'));
            });
            proc.stderr?.on('data', (data: Buffer) => {
                run.appendOutput(data.toString().replace(/\r?\n/g, '\r\n'));
            });
            proc.on('close', (code) => settle(code ?? 1));
            proc.on('error', () => settle(1));
            const buildCancel = token.onCancellationRequested(() => {
                try { proc.kill('SIGTERM'); } catch { /* already exited */ }
            });
            proc.on('close', () => buildCancel.dispose());
        });

        if (buildExitCode !== 0 || token.isCancellationRequested) {
            run.appendOutput('\r\nBuild for testing failed.\r\n');
            const leafItems = this.collectLeafItems(itemsToRun);
            for (const item of leafItems) {
                run.errored(item, new vscode.TestMessage('Build for testing failed'));
            }
            run.end();
            return;
        }

        // 2. Boot simulator
        if (getDestinationType(config) === 'simulator') {
            const udid = config.simulatorUdid || config.simulatorDevice;
            try {
                await execFile('xcrun', ['simctl', 'boot', udid]).catch(() => {});
                await execFile('open', ['-a', 'Simulator']);
            } catch { /* already booted */ }
        }

        // 3. Start test-without-building AND attach debugger simultaneously
        const testCmd = `${buildCmd} test-without-building ${filterArgs} 2>&1`;
        const folder = vscode.workspace.workspaceFolders?.[0];

        // Start the debug session (fire-and-forget — lldb --waitfor blocks until
        // the test host process appears, so we must start tests concurrently)
        // macOS test hosts run natively; the attach-by-name path is iOS-shaped,
        // so run mac tests (with coverage) without a debugger attached.
        if (folder && getDestinationType(config) !== 'mac') {
            const debugConfig: vscode.DebugConfiguration = {
                type: 'lldb-dap',
                request: 'attach',
                name: `Debug Tests (${config.productName})`,
                stopOnEntry: false,
                attachCommands: [
                    `process attach --name ${config.productName} --waitfor --include-existing`,
                ]
            };
            vscode.debug.startDebugging(folder, debugConfig);
        }

        // Run test-without-building (this launches the app, lldb catches it)
        const leafItems = this.collectLeafItems(itemsToRun);
        const reportedItems = await this.executeAndParse(run, testCmd, token);

        for (const item of leafItems) {
            if (!reportedItems.has(item.id)) {
                run.skipped(item);
            }
        }

        // Stop the debug session after tests complete. mac test runs start no
        // session (the attach path is iOS-only), so don't stop an unrelated one.
        if (getDestinationType(config) !== 'mac' && vscode.debug.activeDebugSession) {
            vscode.debug.stopDebugging();
        }

        run.end();
    }

    private buildXcodebuildBase(config: BuildTaskConfig): string {
        const derivedData = derivedDataShellPathForScheme(config.schemeName);
        return [
            'xcodebuild',
            `-project "${config.projectFile}"`,
            `-scheme "${config.schemeName}"`,
            '-configuration Debug',
            ...xcodebuildDestinationFlags(config),
            `-derivedDataPath "${derivedData}"`,
            // A test run installs the same host app, so it must resolve to the same bundle id a build does.
            ...devBundleIdOverrideArgs(config),
        ].join(' ');
    }

    private buildFilterArgs(include: string[], exclude: string[]): string {
        const parts: string[] = [];
        for (const filter of include) {
            parts.push(`-only-testing:"${filter}"`);
        }
        for (const filter of exclude) {
            parts.push(`-skip-testing:"${filter}"`);
        }
        return parts.join(' ');
    }

    private buildCommand(
        config: BuildTaskConfig,
        include: string[],
        exclude: string[],
        options?: { coverage?: boolean }
    ): string {
        const base = this.buildXcodebuildBase(config);
        const filters = this.buildFilterArgs(include, exclude);
        let coverageArgs = '';
        if (options?.coverage) {
            const resultPath = path.join(DERIVED_DATA_BASE, config.schemeName, 'coverage.xcresult');
            this.coverageResultPath = resultPath;
            coverageArgs = ` -enableCodeCoverage YES -resultBundlePath "${resultPath}"`;
        }
        let command = `${base}${coverageArgs} test ${filters} 2>&1`;
        // Boot simulator and open Simulator.app before running tests
        if (getDestinationType(config) === 'simulator') {
            const udid = config.simulatorUdid || config.simulatorDevice;
            command = `xcrun simctl boot "${udid}" 2>/dev/null || true; open -a Simulator; ${command}`;
        }
        if (options?.coverage && this.coverageResultPath) {
            command = `rm -rf "${this.coverageResultPath}"; ${command}`;
        }
        return command;
    }

    private executeAndParse(
        run: vscode.TestRun,
        commandLine: string,
        token: vscode.CancellationToken
    ): Promise<Set<string>> {
        this.activeSpawns++;
        return new Promise<Set<string>>((resolve) => {
            const proc = cp.spawn('/bin/zsh', ['-c', commandLine], {
                cwd: this.rootPath,
                env: process.env,
            });

            const cancelListener = token.onCancellationRequested(() => {
                try { proc.kill('SIGTERM'); } catch { /* already exited */ }
            });

            const failureDetails = new Map<string, FailureDetail[]>();
            const reportedItems = new Set<string>();
            let currentTestItem: vscode.TestItem | undefined;
            let buffer = '';

            const handleData = (data: Buffer) => {
                buffer += data.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    currentTestItem = this.parseLine(run, line, failureDetails, reportedItems, currentTestItem);
                }
            };

            proc.stdout?.on('data', handleData);
            proc.stderr?.on('data', handleData);

            let finished = false;
            const done = () => {
                if (finished) { return; }
                finished = true;
                this.activeSpawns--;
                cancelListener.dispose();
                if (buffer.length > 0) {
                    this.parseLine(run, buffer, failureDetails, reportedItems, currentTestItem);
                }
                resolve(reportedItems);
            };

            proc.on('close', done);
            proc.on('error', done);
        });
    }

    // ── Output parsing ───────────────────────────────────────────

    private parseLine(
        run: vscode.TestRun,
        line: string,
        failureDetails: Map<string, FailureDetail[]>,
        reportedItems: Set<string>,
        currentTestItem: vscode.TestItem | undefined
    ): vscode.TestItem | undefined {
        // xcodebuild uses Objective-C runtime names: -[ModuleName.ClassName methodName]
        // The module prefix (e.g. "PetsTests.PetsTests") must be handled by findTestItem.
        const output = line + '\r\n';

        // Test Case '-[Module.Class method]' started.
        const startMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' started\./.exec(line);
        if (startMatch) {
            const item = this.findTestItem(startMatch[1], startMatch[2]);
            if (item) {
                run.started(item);
                run.appendOutput(output, undefined, item);
                reportedItems.add(item.id);
                return item;
            }
            run.appendOutput(output);
            return currentTestItem;
        }

        // Test Case '-[Module.Class method]' passed (X.XXX seconds).
        const passMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' passed \((\d+\.\d+) seconds\)/.exec(line);
        if (passMatch) {
            const item = this.findTestItem(passMatch[1], passMatch[2]);
            if (item) {
                run.appendOutput(output, undefined, item);
                run.passed(item, parseFloat(passMatch[3]) * 1000);
            } else {
                run.appendOutput(output);
            }
            return undefined;
        }

        // Test Case '-[Module.Class method]' failed (X.XXX seconds).
        const failMatch = /Test Case '-\[([\w.]+)\s+(\w+)\]' failed \((\d+\.\d+) seconds\)/.exec(line);
        if (failMatch) {
            const item = this.findTestItem(failMatch[1], failMatch[2]);
            if (item) {
                run.appendOutput(output, undefined, item);
                const key = `${failMatch[1]}/${failMatch[2]}`;
                const details = failureDetails.get(key);
                const duration = parseFloat(failMatch[3]) * 1000;
                if (details && details.length > 0) {
                    const messages = details.map(d => {
                        const msg = new vscode.TestMessage(d.message);
                        msg.location = new vscode.Location(
                            vscode.Uri.file(d.filePath),
                            new vscode.Position(d.line - 1, 0)
                        );
                        return msg;
                    });
                    run.failed(item, messages, duration);
                } else {
                    run.failed(item, new vscode.TestMessage('Test failed'), duration);
                }
            } else {
                run.appendOutput(output);
            }
            return undefined;
        }

        // Assertion failure: /path/file.swift:42: error: -[Module.Class method] : message
        const assertMatch = /^(.+):(\d+): error: -\[([\w.]+)\s+(\w+)\]\s*:\s*(.+)$/.exec(line);
        if (assertMatch) {
            const key = `${assertMatch[3]}/${assertMatch[4]}`;
            if (!failureDetails.has(key)) {
                failureDetails.set(key, []);
            }
            failureDetails.get(key)!.push({
                message: assertMatch[5].trim(),
                filePath: assertMatch[1],
                line: parseInt(assertMatch[2], 10),
            });
        }

        // Non-test output: associate with currently running test (if any)
        run.appendOutput(output, undefined, currentTestItem);
        return currentTestItem;
    }

    // ── Helpers ──────────────────────────────────────────────────

    private findTestItem(qualifiedClassName: string, methodName: string): vscode.TestItem | undefined {
        // xcodebuild outputs "ModuleName.ClassName" — extract both parts
        const parts = qualifiedClassName.split('.');
        const className = parts.length > 1 ? parts[parts.length - 1] : qualifiedClassName;
        const moduleName = parts.length > 1 ? parts[0] : undefined;

        for (const [, classItem] of this.controller.items) {
            if (classItem.label !== className) { continue; }
            // Disambiguate by module name (matches target name in the item ID)
            if (moduleName && !classItem.id.startsWith(`${moduleName}/`)) { continue; }
            for (const [, methodItem] of classItem.children) {
                if (methodItem.id.endsWith(`/${methodName}`)) {
                    return methodItem;
                }
            }
        }
        return undefined;
    }

    private getAllTopLevelItems(): vscode.TestItem[] {
        const items: vscode.TestItem[] = [];
        for (const [, item] of this.controller.items) {
            items.push(item);
        }
        return items;
    }

    private collectLeafItems(items: readonly vscode.TestItem[]): vscode.TestItem[] {
        const leaves: vscode.TestItem[] = [];
        const walk = (item: vscode.TestItem) => {
            if (item.children.size === 0) {
                leaves.push(item);
            }
            for (const [, child] of item.children) {
                walk(child);
            }
        };
        for (const item of items) { walk(item); }
        return leaves;
    }

    private enqueueAll(run: vscode.TestRun, item: vscode.TestItem): void {
        if (item.children.size === 0) {
            run.enqueued(item);
        }
        for (const [, child] of item.children) {
            this.enqueueAll(run, child);
        }
    }

    // ── Coverage ─────────────────────────────────────────────────

    private async loadCoverageResults(run: vscode.TestRun): Promise<void> {
        if (!this.coverageResultPath) { return; }
        try {
            const { stdout } = await execFile('xcrun', [
                'xccov', 'view', '--report', '--json', this.coverageResultPath
            ]);
            this.coverageReport = JSON.parse(stdout) as XccovReport;

            for (const target of this.coverageReport.targets) {
                for (const file of target.files) {
                    if (file.executableLines === 0) { continue; }
                    // Exclude test target files — their coverage is always ~100% and just noise
                    const isTestFile = this.testTargets.some(t =>
                        file.path.startsWith(t.absolutePath + path.sep)
                    );
                    if (isTestFile) { continue; }
                    run.addCoverage(new vscode.FileCoverage(
                        vscode.Uri.file(file.path),
                        new vscode.TestCoverageCount(file.coveredLines, file.executableLines)
                    ));
                }
            }
        } catch {
            this.coverageReport = undefined;
        }
    }

    private async getDetailedCoverage(fileCoverage: vscode.FileCoverage): Promise<vscode.FileCoverageDetail[]> {
        const details: vscode.FileCoverageDetail[] = [];
        const filePath = fileCoverage.uri.fsPath;

        // Line-level coverage from xccov --archive --file --json
        // Returns: { "/path/to/file.swift": [{ line, isExecutable, executionCount? }, ...] }
        try {
            if (!this.coverageResultPath) { return details; }
            const { stdout } = await execFile('xcrun', [
                'xccov', 'view', '--archive', '--file', filePath, '--json', this.coverageResultPath
            ]);
            const data = JSON.parse(stdout) as Record<string, Array<{
                line: number;
                isExecutable: boolean;
                executionCount?: number;
            }>>;
            const lines = Object.values(data)[0];
            if (lines) {
                for (const entry of lines) {
                    if (entry.isExecutable) {
                        details.push(new vscode.StatementCoverage(
                            entry.executionCount ?? 0,
                            new vscode.Position(entry.line - 1, 0)
                        ));
                    }
                }
            }
        } catch { /* line-level data unavailable */ }

        // Function-level coverage from cached report
        if (this.coverageReport) {
            for (const target of this.coverageReport.targets) {
                const file = target.files.find(f => f.path === filePath);
                if (!file?.functions) { continue; }
                for (const func of file.functions) {
                    details.push(new vscode.DeclarationCoverage(
                        func.name,
                        func.executionCount,
                        new vscode.Position(func.lineNumber - 1, 0)
                    ));
                }
                break;
            }
        }

        return details;
    }

    private loadTestTargets(config: BuildTaskConfig): TestTargetInfo[] {
        try {
            const pbxprojPath = path.join(this.rootPath, config.projectFile, 'project.pbxproj');
            const pbxContents = fs.readFileSync(pbxprojPath, 'utf8');
            const nativeTargets = parseNativeTargets(pbxContents);
            return nativeTargets
                .filter(t => isTestTarget(t.productType))
                .map(t => ({
                    name: t.name,
                    absolutePath: path.join(
                        this.rootPath,
                        determineTargetPath(this.rootPath, t.name, true, t.productName)
                    )
                }));
        } catch {
            return [];
        }
    }
}
