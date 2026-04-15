import type { ExtensionContext } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type TestUri = { fsPath: string; toString: () => string };
type TestWorkspaceFolder = { name: string; uri: TestUri };
type TestConfigurationEvent = { affectsConfiguration: (key: string, folder?: TestWorkspaceFolder) => boolean };
type TestExtensionContext = { extensionMode: number; subscriptions: Array<{ dispose: () => void }> };
type TestWatcherRegistration = {
	baseFolder: TestWorkspaceFolder;
	pattern: string;
	changeListener: ((uri: TestUri) => void) | undefined;
	createListener: ((uri: TestUri) => void) | undefined;
	deleteListener: ((uri: TestUri) => void) | undefined;
};
type TestConfigurationRequest = {
	section: string;
	folder: TestWorkspaceFolder | undefined;
	key: string;
	defaultValue: string[];
};

const createUri = (fsPath: string): TestUri => ({ fsPath, toString: () => fsPath });
const createWorkspaceFolder = (name: string, fsPath: string): TestWorkspaceFolder => ({ name, uri: createUri(fsPath) });
const createContext = (extensionMode: number) => ({ extensionMode, subscriptions: [] }) as TestExtensionContext as unknown as ExtensionContext;
const flushPromises = async (times = 4) => {
	for (let index = 0; index < times; index++) {
		await Promise.resolve();
	}
};

const workspaceState = vi.hoisted(() => ({
	workspaceFolders: [
		{ name: 'repo-a', uri: { fsPath: 'C:/repo-a', toString: () => 'C:/repo-a' } },
		{ name: 'repo-b', uri: { fsPath: 'C:/repo-b', toString: () => 'C:/repo-b' } }
	] as TestWorkspaceFolder[] | undefined,
	watcherRegistrations: [] as TestWatcherRegistration[],
	configListener: undefined as ((event: TestConfigurationEvent) => void) | undefined,
	ignoredDirectories: [] as string[],
	extraIgnoredDirectories: [] as string[],
	configurationRequests: [] as TestConfigurationRequest[],
	registeredCommands: {} as Record<string, (...args: any[]) => any>
}));

const outputSpies = vi.hoisted(() => ({
	appendLine: vi.fn(),
	show: vi.fn()
}));

const workspaceSorterSpies = vi.hoisted(() => ({
	constructors: [] as unknown[],
	sort: vi.fn(async () => undefined),
	enforcePreviousOrderOnMtimeChange: vi.fn(),
	isSelfTriggeredMtimeChange: vi.fn<(uri: TestUri) => boolean>(() => false)
}));

const fsSpies = vi.hoisted(() => ({
	readdir: vi.fn(),
	access: vi.fn(),
	writeFile: vi.fn()
}));

vi.mock('fs', () => ({
	promises: {
		readdir: fsSpies.readdir,
		access: fsSpies.access,
		writeFile: fsSpies.writeFile
	}
}));

vi.mock('../src/WorkspaceSorter.ts', () => {
	class WorkspaceSorterMock {
		static enforcePreviousOrderOnMtimeChange = workspaceSorterSpies.enforcePreviousOrderOnMtimeChange;
		static isSelfTriggeredMtimeChange = workspaceSorterSpies.isSelfTriggeredMtimeChange;
		constructor(workspaceFolder: unknown) {
			workspaceSorterSpies.constructors.push(workspaceFolder);
		}
		sort = workspaceSorterSpies.sort;
	}
	return { default: WorkspaceSorterMock };
});

const vscodeMock = vi.hoisted(() => ({
	ExtensionMode: {
		Development: 1,
		Production: 2
	},
	Uri: {
		file: vi.fn((fsPath: string) => createUri(fsPath))
	},
	RelativePattern: class {
		baseFolder: TestWorkspaceFolder;
		pattern: string;
		constructor(baseFolder: TestWorkspaceFolder, pattern: string) {
			this.baseFolder = baseFolder;
			this.pattern = pattern;
		}
	},
	window: {
		createOutputChannel: vi.fn(() => outputSpies),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
		showTextDocument: vi.fn()
	},
	workspace: {
		get workspaceFolders() {
			return workspaceState.workspaceFolders;
		},
		getConfiguration: vi.fn((section: string, folder?: TestWorkspaceFolder) => ({
			get: vi.fn((key: string, defaultValue: string[]) => {
				workspaceState.configurationRequests.push({ section, folder, key, defaultValue });
				if (section !== 'explorerSorter') {
					return ['__invalid__'];
				}
				if (key === 'ignoredDirectories') {
					return workspaceState.ignoredDirectories;
				}
				if (key === 'extraIgnoredDirectories') {
					return workspaceState.extraIgnoredDirectories;
				}
				return defaultValue;
			})
		})),
		createFileSystemWatcher: vi.fn((relativePattern: { baseFolder: TestWorkspaceFolder; pattern: string }) => {
			const watcherRegistration: TestWatcherRegistration = {
				baseFolder: relativePattern.baseFolder,
				pattern: relativePattern.pattern,
				changeListener: undefined,
				createListener: undefined,
				deleteListener: undefined
			};
			workspaceState.watcherRegistrations.push(watcherRegistration);
			return {
				onDidChange: vi.fn((listener: (uri: TestUri) => void) => {
					watcherRegistration.changeListener = listener;
					return { dispose: vi.fn() };
				}),
				onDidCreate: vi.fn((listener: (uri: TestUri) => void) => {
					watcherRegistration.createListener = listener;
					return { dispose: vi.fn() };
				}),
				onDidDelete: vi.fn((listener: (uri: TestUri) => void) => {
					watcherRegistration.deleteListener = listener;
					return { dispose: vi.fn() };
				}),
				dispose: vi.fn()
			};
		}),
		onDidChangeConfiguration: vi.fn((listener: (event: TestConfigurationEvent) => void) => {
			workspaceState.configListener = listener;
			return { dispose: vi.fn() };
		}),
		openTextDocument: vi.fn()
	},
	commands: {
		registerCommand: vi.fn((command: string, handler: (...args: any[]) => any) => {
			workspaceState.registeredCommands[command] = handler;
			return { dispose: vi.fn() };
		})
	},
	Disposable: class {
		#callback: () => void;
		constructor(callback: () => void) {
			this.#callback = callback;
		}
		dispose() {
			this.#callback();
		}
	}
}));

vi.mock('vscode', () => vscodeMock);

describe('extension', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		workspaceState.workspaceFolders = [createWorkspaceFolder('repo-a', 'C:/repo-a'), createWorkspaceFolder('repo-b', 'C:/repo-b')];
		workspaceState.watcherRegistrations = [];
		workspaceState.configListener = undefined;
		workspaceState.ignoredDirectories = [];
		workspaceState.extraIgnoredDirectories = [];
		workspaceState.configurationRequests = [];
		workspaceState.registeredCommands = {};
		workspaceSorterSpies.constructors.length = 0;
		workspaceSorterSpies.sort.mockReset();
		workspaceSorterSpies.sort.mockResolvedValue(undefined);
		workspaceSorterSpies.enforcePreviousOrderOnMtimeChange.mockReset();
		workspaceSorterSpies.isSelfTriggeredMtimeChange.mockReset();
		workspaceSorterSpies.isSelfTriggeredMtimeChange.mockReturnValue(false);
	});

	it('sorts all workspaces on activation and shows output in development', async () => {
		vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(105).mockReturnValueOnce(200).mockReturnValueOnce(208);
		const context = createContext(vscodeMock.ExtensionMode.Development);
		const { activate } = await import('../src/extension.ts');
		await activate(context);
		expect(workspaceSorterSpies.constructors).toEqual(workspaceState.workspaceFolders);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(2);
		expect(vscodeMock.window.createOutputChannel).toHaveBeenCalledWith('ExplorerSorter');
		expect(vscodeMock.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
		expect(workspaceState.watcherRegistrations).toEqual([
			expect.objectContaining({ baseFolder: workspaceState.workspaceFolders?.[0], pattern: '**' }),
			expect.objectContaining({ baseFolder: workspaceState.workspaceFolders?.[1], pattern: '**' })
		]);
		expect(context.subscriptions).toHaveLength(5);
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Extension "ExplorerSorter" is now active!');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Sorting workspace repo-a on path: C:/repo-a');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Sorting workspace repo-b on path: C:/repo-b');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Workspace repo-a is sorted after 5ms.');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Workspace repo-b is sorted after 8ms.');
		expect(outputSpies.show).toHaveBeenCalledOnce();
	});

	it('restores watcher changes immediately and delays only the follow-up sort', async () => {
		let resolveSort: (() => void) | undefined;
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceSorterSpies.sort.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveSort = () => resolve(undefined);
				})
		);
		workspaceState.watcherRegistrations[0].createListener?.(createUri('C:/repo-a/new.ts'));
		workspaceState.watcherRegistrations[0].deleteListener?.(createUri('C:/repo-a/deleted.ts'));
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledTimes(2);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledWith(
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/new.ts' })
		);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledWith(
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/deleted.ts' })
		);
		resolveSort?.();
		await flushPromises();
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledTimes(2);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(4);
	});

	it('restores every watcher change immediately and coalesces them into one follow-up sort', async () => {
		let resolveSort: (() => void) | undefined;
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceSorterSpies.sort.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveSort = () => resolve(undefined);
				})
		);
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/first.ts'));
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/second.ts'));
		workspaceState.watcherRegistrations[0].deleteListener?.(createUri('C:/repo-a/third.ts'));
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledTimes(3);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenNthCalledWith(
			1,
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/first.ts' })
		);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenNthCalledWith(
			2,
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/second.ts' })
		);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenNthCalledWith(
			3,
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/third.ts' })
		);
		resolveSort?.();
		await flushPromises();
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledTimes(3);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(4);
	});

	it('re-runs a queued config-triggered sort without enforcing path mtimes', async () => {
		let resolveSort: (() => void) | undefined;
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceSorterSpies.sort.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveSort = () => resolve(undefined);
				})
		);
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/file.ts'));
		const affectsConfiguration = vi.fn((key: string, folder?: TestWorkspaceFolder) => key === 'explorerSorter.ignoredDirectories' && folder?.name === 'repo-a');
		workspaceState.configListener?.({ affectsConfiguration });
		resolveSort?.();
		await flushPromises();
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledWith(
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/file.ts' })
		);
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledTimes(1);
		expect(affectsConfiguration).toHaveBeenCalledWith('explorerSorter.ignoredDirectories', workspaceState.workspaceFolders?.[0]);
		expect(affectsConfiguration).toHaveBeenCalledWith('explorerSorter.extraIgnoredDirectories', workspaceState.workspaceFolders?.[0]);
		expect(affectsConfiguration).toHaveBeenCalledWith('explorerSorter.ignoredDirectories', workspaceState.workspaceFolders?.[1]);
		expect(affectsConfiguration).toHaveBeenCalledWith('explorerSorter.extraIgnoredDirectories', workspaceState.workspaceFolders?.[1]);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(4);
	});

	it('ignores self-triggered paths and reads fresh ignore settings for watcher changes', async () => {
		workspaceState.ignoredDirectories = ['bin'];
		workspaceSorterSpies.isSelfTriggeredMtimeChange.mockImplementation((uri: TestUri) => uri.fsPath.endsWith('self.ts'));
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceState.extraIgnoredDirectories = ['cache'];
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/self.ts'));
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/bin/generated.ts'));
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/cache/generated.ts'));
		await flushPromises();
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).not.toHaveBeenCalled();
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(2);
		expect(workspaceState.configurationRequests).toContainEqual({
			section: 'explorerSorter',
			folder: workspaceState.workspaceFolders?.[0],
			key: 'ignoredDirectories',
			defaultValue: []
		});
		expect(workspaceState.configurationRequests).toContainEqual({
			section: 'explorerSorter',
			folder: workspaceState.workspaceFolders?.[0],
			key: 'extraIgnoredDirectories',
			defaultValue: []
		});
	});

	it('does not ignore paths when configuration keys fall back to defaults', async () => {
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/__invalid__/Stryker was here.ts'));
		await flushPromises();
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledWith(
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/__invalid__/Stryker was here.ts' })
		);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(3);
	});

	it('skips startup sorting when no workspace folders exist and does not show output in production', async () => {
		workspaceState.workspaceFolders = undefined;
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		expect(workspaceSorterSpies.sort).not.toHaveBeenCalled();
		expect(workspaceSorterSpies.constructors).toHaveLength(0);
		expect(outputSpies.appendLine).toHaveBeenCalledTimes(1);
		expect(outputSpies.show).not.toHaveBeenCalled();
	});

	it('ignores configuration changes when no workspace folders exist', async () => {
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		workspaceState.workspaceFolders = undefined;
		workspaceState.configListener?.({ affectsConfiguration: vi.fn(() => true) });
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(2);
	});

	it('logs non-error sort failures', async () => {
		workspaceSorterSpies.sort.mockRejectedValueOnce('boom');
		const { activate } = await import('../src/extension.ts');
		await activate(createContext(vscodeMock.ExtensionMode.Production));
		expect(outputSpies.appendLine).toHaveBeenCalledWith('sortWorkspace failed: boom');
	});

	it('logs sort failures, clears queued state on disposal, and still restores incoming paths immediately', async () => {
		let resolveSort: (() => void) | undefined;
		workspaceSorterSpies.sort.mockRejectedValueOnce(new Error('boom'));
		const { activate, deactivate } = await import('../src/extension.ts');
		const context = createContext(vscodeMock.ExtensionMode.Production);
		await activate(context);
		workspaceSorterSpies.sort.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveSort = () => resolve(undefined);
				})
		);
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/file.ts'));
		workspaceState.watcherRegistrations[0].changeListener?.(createUri('C:/repo-a/queued.ts'));
		context.subscriptions.at(-1)?.dispose();
		resolveSort?.();
		await flushPromises();
		deactivate();
		expect(outputSpies.appendLine).toHaveBeenCalledWith('sortWorkspace failed: boom');
		expect(workspaceSorterSpies.enforcePreviousOrderOnMtimeChange).toHaveBeenCalledWith(
			workspaceState.workspaceFolders?.[0],
			expect.objectContaining({ fsPath: 'C:/repo-a/queued.ts' })
		);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(3);
		expect(() => context.subscriptions.at(-1)?.dispose()).not.toThrow();
	});

	describe('generateOrderFile command', () => {
		it('generates .order file with folders before files, all sorted alphabetically', async () => {
			type Dirent = { name: string; isDirectory: () => boolean };
			const mockDirents: Dirent[] = [
				{ name: 'zFolder', isDirectory: () => true },
				{ name: 'aFile.ts', isDirectory: () => false },
				{ name: 'aFolder', isDirectory: () => true },
				{ name: 'zFile.ts', isDirectory: () => false }
			];

			fsSpies.access.mockRejectedValueOnce(new Error('File not found'));
			fsSpies.readdir.mockResolvedValueOnce(mockDirents);
			fsSpies.writeFile.mockResolvedValueOnce(undefined);
			vscodeMock.workspace.openTextDocument.mockResolvedValueOnce({ uri: { fsPath: 'C:/repo/test/.order' } });

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(fsSpies.readdir).toHaveBeenCalledWith('C:/repo/test', { withFileTypes: true });
				expect(fsSpies.writeFile).toHaveBeenCalledWith('C:\\repo\\test\\.order', 'aFolder\nzFolder\naFile.ts\nzFile.ts\n', 'utf8');
				expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith('.order file generated successfully!');
			}
		});

		it('shows error message when no folder is selected', async () => {
			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(undefined);

				expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith('Please select a folder to generate the .order file.');
				expect(fsSpies.readdir).not.toHaveBeenCalled();
			}
		});

		it('asks for confirmation and overwrites existing .order file when user selects Yes', async () => {
			type Dirent = { name: string; isDirectory: () => boolean };
			const mockDirents: Dirent[] = [
				{ name: 'file1.ts', isDirectory: () => false },
				{ name: 'file2.ts', isDirectory: () => false }
			];

			fsSpies.access.mockResolvedValueOnce(undefined); // File exists
			vscodeMock.window.showWarningMessage.mockResolvedValueOnce('Yes');
			fsSpies.readdir.mockResolvedValueOnce(mockDirents);
			fsSpies.writeFile.mockResolvedValueOnce(undefined);
			vscodeMock.workspace.openTextDocument.mockResolvedValueOnce({ uri: { fsPath: 'C:/repo/test/.order' } });

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith('.order file already exists. Do you want to overwrite it?', { modal: true }, 'Yes', 'No');
				expect(fsSpies.writeFile).toHaveBeenCalledWith('C:\\repo\\test\\.order', 'file1.ts\nfile2.ts\n', 'utf8');
			}
		});

		it('does not overwrite existing .order file when user selects No', async () => {
			fsSpies.access.mockResolvedValueOnce(undefined); // File exists
			vscodeMock.window.showWarningMessage.mockResolvedValueOnce('No');

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(vscodeMock.window.showWarningMessage).toHaveBeenCalledWith('.order file already exists. Do you want to overwrite it?', { modal: true }, 'Yes', 'No');
				expect(fsSpies.writeFile).not.toHaveBeenCalled();
			}
		});

		it('logs and shows error message when file system operations fail', async () => {
			const errorMessage = 'Permission denied';
			fsSpies.access.mockRejectedValueOnce(new Error('File not found'));
			fsSpies.readdir.mockRejectedValueOnce(new Error(errorMessage));

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(outputSpies.appendLine).toHaveBeenCalledWith(`generateOrderFile failed: ${errorMessage}`);
				expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(`Failed to generate .order file: ${errorMessage}`);
			}
		});

		it('logs and shows error message when a non-Error object is thrown', async () => {
			const errorValue = 'custom error string';
			fsSpies.access.mockRejectedValueOnce(new Error('File not found'));
			fsSpies.readdir.mockRejectedValueOnce(errorValue);

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(outputSpies.appendLine).toHaveBeenCalledWith(`generateOrderFile failed: ${errorValue}`);
				expect(vscodeMock.window.showErrorMessage).toHaveBeenCalledWith(`Failed to generate .order file: ${errorValue}`);
			}
		});

		it('generates empty .order file for empty folder', async () => {
			fsSpies.access.mockRejectedValueOnce(new Error('File not found'));
			fsSpies.readdir.mockResolvedValueOnce([]);
			fsSpies.writeFile.mockResolvedValueOnce(undefined);
			vscodeMock.workspace.openTextDocument.mockResolvedValueOnce({ uri: { fsPath: 'C:/repo/test/.order' } });

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(fsSpies.writeFile).toHaveBeenCalledWith('C:\\repo\\test\\.order', '', 'utf8');
				expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith('.order file generated successfully!');
			}
		});

		it('opens the generated .order file in the editor', async () => {
			type Dirent = { name: string; isDirectory: () => boolean };
			const mockDirents: Dirent[] = [{ name: 'file.ts', isDirectory: () => false }];
			const mockDocument = { uri: { fsPath: 'C:/repo/test/.order' } };

			fsSpies.access.mockRejectedValueOnce(new Error('File not found'));
			fsSpies.readdir.mockResolvedValueOnce(mockDirents);
			fsSpies.writeFile.mockResolvedValueOnce(undefined);
			vscodeMock.workspace.openTextDocument.mockResolvedValueOnce(mockDocument);

			const { activate } = await import('../src/extension.ts');
			const context = createContext(vscodeMock.ExtensionMode.Production);
			await activate(context);

			const generateCommand = workspaceState.registeredCommands['explorerSorter.generateOrderFile'];
			expect(generateCommand).toBeDefined();

			if (generateCommand) {
				await generateCommand(createUri('C:/repo/test'));

				expect(vscodeMock.workspace.openTextDocument).toHaveBeenCalledWith('C:\\repo\\test\\.order');
				expect(vscodeMock.window.showTextDocument).toHaveBeenCalledWith(mockDocument);
			}
		});
	});
});
