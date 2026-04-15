import type { Uri, WorkspaceFolder } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toUri = (fsPath: string) => ({ fsPath, path: fsPath }) as unknown as Uri;
const toWorkspaceFolder = (fsPath: string) => ({ uri: toUri(fsPath) }) as unknown as WorkspaceFolder;

const workspaceState = vi.hoisted(() => ({
	directories: new Map<string, Array<[string, number]>>(),
	orderFiles: new Map<string, string>(),
	ignoredDirectories: ['.git'],
	extraIgnoredDirectories: [] as string[]
}));

const fsSpies = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	statSync: vi.fn(() => ({ mtime: new Date(0) })),
	utimesSync: vi.fn()
}));

const configurationSpies = vi.hoisted(() => ({
	get: vi.fn((key: string, defaultValue: string[] = []) => {
		if (key === 'ignoredDirectories') {
			return workspaceState.ignoredDirectories ?? defaultValue;
		}
		if (key === 'extraIgnoredDirectories') {
			return workspaceState.extraIgnoredDirectories ?? defaultValue;
		}
		return defaultValue;
	})
}));

const vscodeMock = vi.hoisted(() => {
	const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+/g, '/');
	const toUri = (fsPath: string) => ({
		fsPath: normalize(fsPath),
		path: normalize(fsPath),
		toString: () => normalize(fsPath)
	});
	const joinPath = (base: { fsPath: string }, ...segments: string[]) => toUri([base.fsPath, ...segments].join('/'));

	return {
		FileType: {
			File: 1,
			Directory: 2
		},
		Uri: {
			file: vi.fn((fsPath: string) => toUri(fsPath)),
			joinPath: vi.fn(joinPath)
		},
		workspace: {
			fs: {
				readDirectory: vi.fn(async (uri: { fsPath: string }) => workspaceState.directories.get(normalize(uri.fsPath)) ?? []),
				readFile: vi.fn(async (uri: { fsPath: string }) => new TextEncoder().encode(workspaceState.orderFiles.get(normalize(uri.fsPath)) ?? ''))
			},
			getConfiguration: vi.fn((section?: string) => ({
				get: vi.fn((key: string, defaultValue: string[] = []) => {
					if (section !== 'explorerSorter') {
						return ['__invalid__'];
					}
					return configurationSpies.get(key, defaultValue);
				})
			}))
		}
	};
});

vi.mock('fs', () => fsSpies);
vi.mock('vscode', () => vscodeMock);

describe('WorkspaceSorter', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock('../src/OrderRulesParser.ts');
		vi.clearAllMocks();
		workspaceState.directories.clear();
		workspaceState.orderFiles.clear();
		workspaceState.ignoredDirectories = ['.git'];
		workspaceState.extraIgnoredDirectories = [];
		vi.restoreAllMocks();
		configurationSpies.get.mockClear();
	});

	it('sorts exact and glob matches before lexical remainder', async () => {
		// Arrange
		vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(20_000);
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2],
			['notes.md', 1],
			['.env.md', 1],
			['zeta.ts', 1],
			['alpha.ts', 1]
		]);
		workspaceState.directories.set('C:/repo/src', [
			['nested.ts', 1],
			['omega.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', 'src\n**/*.md\n');
		workspaceState.orderFiles.set('C:/repo/src/.order', 'src/nested.ts');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		const touchedPaths = fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath);
		expect(vscodeMock.workspace.getConfiguration).toHaveBeenCalledTimes(2);
		expect(vscodeMock.workspace.getConfiguration).toHaveBeenNthCalledWith(1, 'explorerSorter');
		expect(vscodeMock.workspace.getConfiguration).toHaveBeenNthCalledWith(2, 'explorerSorter');
		expect(configurationSpies.get).toHaveBeenCalledTimes(2);
		expect(configurationSpies.get).toHaveBeenNthCalledWith(1, 'ignoredDirectories', []);
		expect(configurationSpies.get).toHaveBeenNthCalledWith(2, 'extraIgnoredDirectories', []);
		expect(touchedPaths).toEqual([
			'C:/repo/.env.md',
			'C:/repo/notes.md',
			'C:/repo/src',
			'C:/repo/.order',
			'C:/repo/alpha.ts',
			'C:/repo/zeta.ts',
			'C:/repo/src/nested.ts',
			'C:/repo/src/omega.ts'
		]);
		expect(fsSpies.utimesSync.mock.calls[0]?.[1]).toEqual(new Date(10_000));
		expect(fsSpies.utimesSync.mock.calls[1]?.[1]).toEqual(new Date(8_900));
		expect(fsSpies.utimesSync.mock.calls[2]?.[1]).toEqual(new Date(7_800));
		expect(fsSpies.utimesSync.mock.calls[3]?.[1]).toEqual(new Date(6_700));
		expect(fsSpies.utimesSync.mock.calls[4]?.[1]).toEqual(new Date(5_600));
		expect(fsSpies.utimesSync.mock.calls[5]?.[1]).toEqual(new Date(4_500));
		expect(fsSpies.utimesSync.mock.calls[6]?.[1]).toEqual(new Date(20_000));
		expect(fsSpies.utimesSync.mock.calls[7]?.[1]).toEqual(new Date(18_900));
	});

	it('skips ignored directories during recursion', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['.git', 2],
			['cache', 2],
			['src', 2]
		]);
		workspaceState.directories.set('C:/repo/src', [['main.ts', 1]]);
		workspaceState.directories.set('C:/repo/.git', [['config', 1]]);
		workspaceState.directories.set('C:/repo/cache', [['artifact.ts', 1]]);
		workspaceState.extraIgnoredDirectories = ['cache'];

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(vscodeMock.workspace.fs.readDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'C:/repo' }));
		expect(vscodeMock.workspace.fs.readDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'C:/repo/src' }));
		expect(vscodeMock.workspace.fs.readDirectory).not.toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'C:/repo/.git' }));
		expect(vscodeMock.workspace.fs.readDirectory).not.toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'C:/repo/cache' }));
	});

	it('reuses cached order and restores saved file mtimes', async () => {
		// Arrange
		vi.spyOn(Date, 'now').mockReturnValueOnce(10_000).mockReturnValueOnce(20_000).mockReturnValueOnce(30_000);
		workspaceState.directories.set('C:/repo', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		const firstRunCalls = fsSpies.utimesSync.mock.calls.length;
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.length).toBe(firstRunCalls);

		fsSpies.utimesSync.mockClear();
		workspaceState.orderFiles.set('C:/repo/.order', 'beta.ts');
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(toWorkspaceFolder('C:/repo'), toUri('C:/repo/alpha.ts'));

		// Assert
		expect(fsSpies.utimesSync).toHaveBeenCalledTimes(1);
		expect(fsSpies.utimesSync).toHaveBeenLastCalledWith('C:/repo/alpha.ts', expect.any(Date), expect.any(Date));
	});

	it('detects self-triggered mtime changes when cached mtime matches disk mtime', async () => {
		workspaceState.directories.set('C:/repo', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		vi.spyOn(Date, 'now').mockReturnValue(10_000);
		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));
		await sorter.sort();
		fsSpies.statSync.mockReturnValueOnce({ mtime: new Date(10_000) });
		expect(WorkspaceSorter.isSelfTriggeredMtimeChange(toUri('C:/repo/alpha.ts'))).toBe(true);
		expect(fsSpies.statSync).toHaveBeenCalledWith('C:/repo/alpha.ts');
	});

	it('ignores self-trigger checks when no cached mtime exists or the file is missing', async () => {
		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		expect(WorkspaceSorter.isSelfTriggeredMtimeChange(toUri('C:/repo/uncached.ts'))).toBe(false);
		expect(fsSpies.existsSync).not.toHaveBeenCalled();
		expect(fsSpies.statSync).not.toHaveBeenCalled();
		fsSpies.existsSync.mockReturnValueOnce(false);
		expect(WorkspaceSorter.isSelfTriggeredMtimeChange(toUri('C:/repo/missing.ts'))).toBe(false);
		expect(fsSpies.statSync).not.toHaveBeenCalled();
	});

	it('applies exact rules using workspace-relative paths only', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2],
			['alpha', 2]
		]);
		workspaceState.directories.set('C:/repo/src', [
			['beta.ts', 1],
			['alpha.ts', 1]
		]);
		workspaceState.directories.set('C:/repo/alpha', [['zzz.ts', 1]]);
		workspaceState.orderFiles.set('C:/repo/.order', 'src/alpha.ts');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		const touchedPaths = fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath);
		expect(touchedPaths).toContain('C:/repo/src/alpha.ts');
		expect(touchedPaths.indexOf('C:/repo/src/alpha.ts')).toBeLessThan(touchedPaths.indexOf('C:/repo/src/beta.ts'));
	});

	it('applies glob rules using workspace-relative paths only', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2],
			['root.ts', 1]
		]);
		workspaceState.directories.set('C:/repo/src', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', '**/beta.ts');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		const touchedPaths = fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath);
		expect(touchedPaths.indexOf('C:/repo/src/beta.ts')).toBeLessThan(touchedPaths.indexOf('C:/repo/src/alpha.ts'));
		expect(touchedPaths).toContain('C:/repo/root.ts');
	});

	it('reapplies files when only a trailing entry stays in the same position', async () => {
		// Arrange
		const getOrderRules = vi
			.fn()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ line: 'beta.ts', lineType: 'exact' }]);
		vi.doMock('../src/OrderRulesParser.ts', () => ({
			default: {
				getOrderRules
			}
		}));
		workspaceState.directories.set('C:/repo', [
			['alpha.ts', 1],
			['beta.ts', 1],
			['gamma.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		await sorter.sort();

		// Assert
		expect(getOrderRules).toHaveBeenNthCalledWith(1, [], expect.objectContaining({ fsPath: 'C:/repo' }), ['alpha.ts', 'beta.ts', 'gamma.ts']);
		expect(getOrderRules).toHaveBeenNthCalledWith(2, [], expect.objectContaining({ fsPath: 'C:/repo' }), ['alpha.ts', 'beta.ts', 'gamma.ts']);
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/beta.ts', 'C:/repo/alpha.ts', 'C:/repo/gamma.ts']);
	});

	it('does not treat exact-only rules as glob rules', async () => {
		// Arrange
		vi.doMock('../src/OrderRulesParser.ts', () => ({
			default: {
				getOrderRules: vi.fn(async () => [{ line: '**/beta.ts', lineType: 'exact' }])
			}
		}));
		workspaceState.directories.set('C:/repo', [
			['beta.ts', 1],
			['alpha.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/alpha.ts', 'C:/repo/beta.ts']);
	});

	it('does not treat glob-only rules as exact rules', async () => {
		// Arrange
		vi.doMock('../src/OrderRulesParser.ts', () => ({
			default: {
				getOrderRules: vi.fn(async () => [{ line: 'src/beta[1].ts', lineType: 'glob' }])
			}
		}));
		workspaceState.directories.set('C:/repo', [['src', 2]]);
		workspaceState.directories.set('C:/repo/src', [
			['alpha.ts', 1],
			['beta[1].ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/src', 'C:/repo/src/alpha.ts', 'C:/repo/src/beta[1].ts']);
	});

	it('keeps lexical order when no rules match and applies dot globs in child folders', async () => {
		// Arrange
		vi.spyOn(Date, 'now').mockReturnValueOnce(30_000).mockReturnValueOnce(40_000);
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2],
			['beta.ts', 1],
			['alpha.ts', 1]
		]);
		workspaceState.directories.set('C:/repo/src', [
			['.order', 1],
			['visible.ts', 1],
			['.hidden.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', 'missing.ts');
		workspaceState.orderFiles.set('C:/repo/src/.order', 'src/.hidden.ts');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual([
			'C:/repo/.order',
			'C:/repo/alpha.ts',
			'C:/repo/beta.ts',
			'C:/repo/src',
			'C:/repo/src/.hidden.ts',
			'C:/repo/src/.order',
			'C:/repo/src/visible.ts'
		]);
	});

	it('keeps directory and file caches separate when only file ordering changes', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['folder', 2],
			['alpha.ts', 1],
			['beta.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['folder', 2],
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', 'beta.ts');
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/beta.ts', 'C:/repo/.order', 'C:/repo/alpha.ts', 'C:/repo/folder']);
	});

	it('does not reuse file cache across sibling directories with the same file names', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['first', 2],
			['second', 2]
		]);
		workspaceState.directories.set('C:/repo/first', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		workspaceState.directories.set('C:/repo/second', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual([
			'C:/repo/first',
			'C:/repo/second',
			'C:/repo/first/alpha.ts',
			'C:/repo/first/beta.ts',
			'C:/repo/second/alpha.ts',
			'C:/repo/second/beta.ts'
		]);
	});

	it('does not reuse directory cache across sibling directories with the same child directories', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [
			['first', 2],
			['second', 2]
		]);
		workspaceState.directories.set('C:/repo/first', [
			['a', 2],
			['b', 2]
		]);
		workspaceState.directories.set('C:/repo/second', [
			['a', 2],
			['b', 2]
		]);
		workspaceState.directories.set('C:/repo/first/a', []);
		workspaceState.directories.set('C:/repo/first/b', []);
		workspaceState.directories.set('C:/repo/second/a', []);
		workspaceState.directories.set('C:/repo/second/b', []);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual([
			'C:/repo/first',
			'C:/repo/second',
			'C:/repo/first/a',
			'C:/repo/first/b',
			'C:/repo/second/a',
			'C:/repo/second/b'
		]);
	});

	it('does not reuse file cache when an entry becomes a directory', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['alpha', 1]]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		workspaceState.directories.set('C:/repo', [['alpha', 2]]);
		workspaceState.directories.set('C:/repo/alpha', []);
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/alpha']);
	});

	it('reapplies files when same-length order changes', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['src', 2]]);
		workspaceState.directories.set('C:/repo/src', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', 'missing');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		workspaceState.orderFiles.set('C:/repo/.order', 'src/beta.ts');
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2]
		]);
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/.order', 'C:/repo/src', 'C:/repo/src/beta.ts', 'C:/repo/src/alpha.ts']);
	});

	it('reapplies files when same-length order changes after a shared prefix', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['src', 2]]);
		workspaceState.directories.set('C:/repo/src', [
			['alpha.ts', 1],
			['beta.ts', 1],
			['gamma.ts', 1]
		]);
		workspaceState.orderFiles.set('C:/repo/.order', 'missing');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		workspaceState.orderFiles.set('C:/repo/.order', 'src/gamma.ts');
		workspaceState.directories.set('C:/repo', [
			['.order', 1],
			['src', 2]
		]);
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual([
			'C:/repo/.order',
			'C:/repo/src',
			'C:/repo/src/gamma.ts',
			'C:/repo/src/alpha.ts',
			'C:/repo/src/beta.ts'
		]);
	});

	it('does not touch missing order files for single-entry directories', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['single.ts', 1]]);
		const toSortedSpy = vi.spyOn(Array.prototype, 'toSorted');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(vscodeMock.workspace.fs.readFile).not.toHaveBeenCalled();
		expect(toSortedSpy).not.toHaveBeenCalled();
		expect(fsSpies.utimesSync).toHaveBeenCalledTimes(1);
	});

	it('ignores saved file mtimes when no cached timestamp exists', async () => {
		// Arrange
		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');

		// Act
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(toWorkspaceFolder('C:/repo'), toUri('C:/repo/missing.ts'));

		// Assert
		expect(fsSpies.utimesSync).not.toHaveBeenCalled();
	});

	it('stops recursive mtime enforcement at the workspace root', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['src', 2]]);
		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		vscodeMock.Uri.file.mockClear();
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(toWorkspaceFolder('C:/repo'), toUri('C:/repo'));

		// Assert
		expect(fsSpies.utimesSync).not.toHaveBeenCalled();
		expect(vscodeMock.Uri.file).not.toHaveBeenCalled();
	});

	it('recursively restores cached mtimes up to the workspace root', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', [['src', 2]]);
		workspaceState.directories.set('C:/repo/src', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);
		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		vscodeMock.Uri.file.mockClear();
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(toWorkspaceFolder('C:/repo'), toUri('C:/repo/src/alpha.ts'));

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/src']);
		expect(vscodeMock.Uri.file.mock.calls.map(([filePath]) => filePath)).toEqual(['C:/repo/src', 'C:/repo']);
	});

	it('does nothing for empty directories without rules', async () => {
		// Arrange
		workspaceState.directories.set('C:/repo', []);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:/repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(vscodeMock.workspace.fs.readDirectory).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'C:/repo' }));
		expect(fsSpies.utimesSync).not.toHaveBeenCalled();
	});
});
