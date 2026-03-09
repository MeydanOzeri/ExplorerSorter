import { beforeEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({
	workspaceFolders: [
		{ name: 'repo-a', uri: { fsPath: 'C:/repo-a', toString: () => 'C:/repo-a' } },
		{ name: 'repo-b', uri: { fsPath: 'C:/repo-b', toString: () => 'C:/repo-b' } }
	] as any[] | undefined,
	workspaceFolderByUri: new Map<string, any>(),
	saveListener: undefined as ((document: any) => void) | undefined,
	renameListener: undefined as ((event: any) => void) | undefined,
	createListener: undefined as ((event: any) => void) | undefined,
	deleteListener: undefined as ((event: any) => void) | undefined,
	configListener: undefined as ((event: any) => void) | undefined
}));

const outputSpies = vi.hoisted(() => ({
	appendLine: vi.fn(),
	show: vi.fn()
}));

const timerState = vi.hoisted(() => ({
	callbacks: [] as Array<() => void>
}));

const workspaceSorterSpies = vi.hoisted(() => ({
	constructors: [] as any[],
	sort: vi.fn(async () => undefined),
	updateSavedFileMtime: vi.fn()
}));

vi.mock('../src/WorkspaceSorter.ts', () => {
	class WorkspaceSorterMock {
		static updateSavedFileMtime = workspaceSorterSpies.updateSavedFileMtime;

		constructor(workspaceFolder: any) {
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
	window: {
		createOutputChannel: vi.fn(() => outputSpies)
	},
	workspace: {
		get workspaceFolders() {
			return workspaceState.workspaceFolders;
		},
		getWorkspaceFolder: vi.fn((uri: { fsPath: string }) => workspaceState.workspaceFolderByUri.get(uri.fsPath)),
		onDidSaveTextDocument: vi.fn((listener: (document: any) => void) => {
			workspaceState.saveListener = listener;
			return { dispose: vi.fn() };
		}),
		onDidRenameFiles: vi.fn((listener: (event: any) => void) => {
			workspaceState.renameListener = listener;
			return { dispose: vi.fn() };
		}),
		onDidCreateFiles: vi.fn((listener: (event: any) => void) => {
			workspaceState.createListener = listener;
			return { dispose: vi.fn() };
		}),
		onDidDeleteFiles: vi.fn((listener: (event: any) => void) => {
			workspaceState.deleteListener = listener;
			return { dispose: vi.fn() };
		}),
		onDidChangeConfiguration: vi.fn((listener: (event: any) => void) => {
			workspaceState.configListener = listener;
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
		vi.restoreAllMocks();
		workspaceState.workspaceFolders = [
			{ name: 'repo-a', uri: { fsPath: 'C:/repo-a', toString: () => 'C:/repo-a' } },
			{ name: 'repo-b', uri: { fsPath: 'C:/repo-b', toString: () => 'C:/repo-b' } }
		];
		workspaceSorterSpies.constructors.length = 0;
		workspaceState.workspaceFolderByUri = new Map([
			['C:/repo-a/file.ts', workspaceState.workspaceFolders[0]],
			['C:/repo-b/file.ts', workspaceState.workspaceFolders[1]],
			['C:/repo-a/new.ts', workspaceState.workspaceFolders[0]],
			['C:/repo-a/renamed.ts', workspaceState.workspaceFolders[0]],
			['C:/repo-b/renamed.ts', workspaceState.workspaceFolders[1]],
			['C:/repo-a/deleted.ts', workspaceState.workspaceFolders[0]]
		]);
		workspaceState.saveListener = undefined;
		workspaceState.renameListener = undefined;
		workspaceState.createListener = undefined;
		workspaceState.deleteListener = undefined;
		workspaceState.configListener = undefined;
		timerState.callbacks = [];
		vi.stubGlobal(
			'setTimeout',
			vi.fn((callback: () => void) => {
				timerState.callbacks.push(callback);
				return timerState.callbacks.length as any;
			})
		);
		vi.stubGlobal('clearTimeout', vi.fn());
	});

	it('sorts all workspaces on activation and shows output in development', async () => {
		// Arrange
		vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(105).mockReturnValueOnce(200).mockReturnValueOnce(208);
		const { activate } = await import('../src/extension.ts');

		// Act
		await activate({ extensionMode: vscodeMock.ExtensionMode.Development, subscriptions: [] } as any);

		// Assert
		expect(workspaceSorterSpies.constructors).toEqual(workspaceState.workspaceFolders);
		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(2);
		expect(vscodeMock.window.createOutputChannel).toHaveBeenCalledWith('ExplorerSorter');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Extension "ExplorerSorter" is now active!');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Sorting workspace repo-a on path: C:/repo-a');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Sorting workspace repo-b on path: C:/repo-b');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Workspace repo-a is sorted after 5ms.');
		expect(outputSpies.appendLine).toHaveBeenCalledWith('Workspace repo-b is sorted after 8ms.');
		expect(outputSpies.show).toHaveBeenCalledOnce();
	});

	it('reacts to save, rename, create, delete and relevant config changes', async () => {
		// Arrange
		const { activate } = await import('../src/extension.ts');
		await activate({ extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] } as any);

		// Act
		workspaceState.saveListener?.({ uri: { fsPath: 'C:/repo-a/file.ts' } });
		workspaceState.renameListener?.({ files: [{ newUri: { fsPath: 'C:/repo-a/renamed.ts' } }, { newUri: { fsPath: 'C:/repo-b/renamed.ts' } }, { newUri: { fsPath: 'C:/repo-a/renamed.ts' } }] });
		workspaceState.createListener?.({ files: [{ fsPath: 'C:/repo-a/new.ts' }, { fsPath: 'C:/repo-a/new.ts' }] });
		workspaceState.deleteListener?.({ files: [{ fsPath: 'C:/repo-a/deleted.ts' }, { fsPath: 'C:/repo-a/deleted.ts' }] });
		workspaceState.configListener?.({
			affectsConfiguration: vi.fn((key: string, folder: any) => key === 'explorerSorter.ignoredDirectories' && folder.name === 'repo-a')
		});

		// Assert
		expect(workspaceSorterSpies.updateSavedFileMtime).toHaveBeenCalledWith({ fsPath: 'C:/repo-a/file.ts' });
		expect(setTimeout).toHaveBeenCalledTimes(6);
		expect(vscodeMock.workspace.getWorkspaceFolder).toHaveBeenCalledTimes(8);

		for (const callback of timerState.callbacks) {
			callback();
		}
		await Promise.resolve();

		expect(workspaceSorterSpies.sort).toHaveBeenCalledTimes(8);
	});

	it('ignores workspace events without a matching workspace folder', async () => {
		// Arrange
		const { activate } = await import('../src/extension.ts');
		await activate({ extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] } as any);

		// Act
		workspaceState.saveListener?.({ uri: { fsPath: 'C:/outside/file.ts' } });
		workspaceState.configListener?.({ affectsConfiguration: vi.fn(() => false) });

		// Assert
		expect(workspaceSorterSpies.updateSavedFileMtime).not.toHaveBeenCalledWith({ fsPath: 'C:/outside/file.ts' });
		expect(setTimeout).not.toHaveBeenCalled();
	});

	it('skips startup sorting when no workspace folders exist and does not show output in production', async () => {
		// Arrange
		workspaceState.workspaceFolders = undefined;
		const { activate } = await import('../src/extension.ts');

		// Act
		await activate({ extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] } as any);

		// Assert
		expect(workspaceSorterSpies.sort).not.toHaveBeenCalled();
		expect(workspaceSorterSpies.constructors).toHaveLength(0);
		expect(outputSpies.appendLine).toHaveBeenCalledTimes(1);
		expect(outputSpies.show).not.toHaveBeenCalled();
	});

	it('ignores configuration changes when no workspace folders exist', async () => {
		// Arrange
		const { activate } = await import('../src/extension.js');
		await activate({ extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] } as any);
		workspaceState.workspaceFolders = undefined;

		// Act
		workspaceState.configListener?.({ affectsConfiguration: vi.fn(() => true) });

		// Assert
		expect(setTimeout).not.toHaveBeenCalled();
	});

	it('logs non-error sort failures and skips undefined workspace folders from file events', async () => {
		// Arrange
		workspaceSorterSpies.sort.mockRejectedValueOnce('boom');
		workspaceState.workspaceFolderByUri.set('C:/repo-a/missing.ts', undefined);
		const { activate } = await import('../src/extension.ts');
		await activate({ extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] } as any);

		// Act
		workspaceState.renameListener?.({ files: [{ newUri: { fsPath: 'C:/repo-a/renamed.ts' } }, { newUri: { fsPath: 'C:/repo-a/missing.ts' } }] });
		workspaceState.createListener?.({ files: [{ fsPath: 'C:/repo-a/new.ts' }, { fsPath: 'C:/repo-a/missing.ts' }] });
		workspaceState.deleteListener?.({ files: [{ fsPath: 'C:/repo-a/deleted.ts' }, { fsPath: 'C:/repo-a/missing.ts' }] });
		workspaceState.configListener?.({
			affectsConfiguration: vi.fn((key: string) => key === 'explorerSorter.extraIgnoredDirectories')
		});
		await Promise.resolve();

		// Assert
		expect(outputSpies.appendLine).toHaveBeenCalledWith('sortWorkspace failed: boom');
		expect(vscodeMock.workspace.getWorkspaceFolder).toHaveBeenCalledWith({ fsPath: 'C:/repo-a/missing.ts' });
		expect(setTimeout).toHaveBeenCalledTimes(5);
	});

	it('logs sort failures and clears debounce timers on disposal', async () => {
		// Arrange
		workspaceSorterSpies.sort.mockRejectedValueOnce(new Error('boom'));
		workspaceState.workspaceFolderByUri.set('C:/repo-b/file.ts', workspaceState.workspaceFolders?.[1]);
		const { activate, deactivate } = await import('../src/extension.ts');
		const context = { extensionMode: vscodeMock.ExtensionMode.Production, subscriptions: [] as Array<{ dispose: () => void }> } as any;

		// Act
		await activate(context);
		workspaceState.saveListener?.({ uri: { fsPath: 'C:/repo-a/file.ts' } });
		workspaceState.saveListener?.({ uri: { fsPath: 'C:/repo-b/file.ts' } });
		context.subscriptions.at(-1)?.dispose();
		deactivate();

		// Assert
		expect(outputSpies.appendLine).toHaveBeenCalledWith('sortWorkspace failed: boom');
		expect(clearTimeout).toHaveBeenCalledWith(1);
		expect(clearTimeout).toHaveBeenCalledWith(2);
	});
});
