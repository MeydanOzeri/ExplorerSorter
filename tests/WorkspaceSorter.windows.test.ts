import type { Uri, WorkspaceFolder } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toUri = (fsPath: string) => ({ fsPath, path: fsPath }) as unknown as Uri;
const toWorkspaceFolder = (fsPath: string) => ({ uri: toUri(fsPath) }) as unknown as WorkspaceFolder;

const workspaceState = vi.hoisted(() => ({
	directories: new Map<string, Array<[string, number]>>(),
	orderFiles: new Map<string, string>()
}));

const fsSpies = vi.hoisted(() => ({
	existsSync: vi.fn(() => true),
	utimesSync: vi.fn()
}));

const vscodeMock = vi.hoisted(() => {
	const normalize = (value: string) => value.replaceAll('/', '\\').replace(/\\+/g, '\\');
	const toUri = (fsPath: string) => ({
		fsPath: normalize(fsPath),
		path: normalize(fsPath),
		toString: () => normalize(fsPath)
	});
	const joinPath = (base: { fsPath: string }, ...segments: string[]) => toUri([base.fsPath, ...segments].join('\\'));

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
			getConfiguration: vi.fn(() => ({
				get: vi.fn((key: string) => (key === 'ignoredDirectories' || key === 'extraIgnoredDirectories' ? [] : []))
			}))
		}
	};
});

vi.mock('fs', () => fsSpies);
vi.mock('vscode', () => vscodeMock);

describe('WorkspaceSorter windows paths', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doUnmock('../src/OrderRulesParser.ts');
		vi.clearAllMocks();
		workspaceState.directories.clear();
		workspaceState.orderFiles.clear();
	});

	it('matches globs against workspace-relative paths on windows separators', async () => {
		// Arrange
		workspaceState.directories.set('C:\\repo', [
			['.order', 1],
			['src', 2]
		]);
		workspaceState.directories.set('C:\\repo\\src', [
			['beta.ts', 1],
			['alpha.ts', 1]
		]);
		workspaceState.orderFiles.set('C:\\repo\\.order', 'src/beta.ts');

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:\\repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:\\repo\\.order', 'C:\\repo\\src', 'C:\\repo\\src\\beta.ts', 'C:\\repo\\src\\alpha.ts']);
	});

	it('does not match glob rules against absolute windows paths', async () => {
		// Arrange
		vi.doMock('../src/OrderRulesParser.ts', () => ({
			default: {
				getOrderRules: vi.fn(async () => [{ line: 'src/beta.ts', lineType: 'glob' }])
			}
		}));
		workspaceState.directories.set('C:\\repo', [['src', 2]]);
		workspaceState.directories.set('C:\\repo\\src', [
			['alpha.ts', 1],
			['beta.ts', 1]
		]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:\\repo'));

		// Act
		await sorter.sort();

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:\\repo\\src', 'C:\\repo\\src\\beta.ts', 'C:\\repo\\src\\alpha.ts']);
	});

	it('restores cached mtimes up the windows path hierarchy', async () => {
		// Arrange
		workspaceState.directories.set('C:\\repo', [['src', 2]]);
		workspaceState.directories.set('C:\\repo\\src', [['alpha.ts', 1]]);

		const { default: WorkspaceSorter } = await import('../src/WorkspaceSorter.ts');
		const sorter = new WorkspaceSorter(toWorkspaceFolder('C:\\repo'));

		// Act
		await sorter.sort();
		fsSpies.utimesSync.mockClear();
		vscodeMock.Uri.file.mockClear();
		WorkspaceSorter.enforcePreviousOrderOnMtimeChange(toWorkspaceFolder('C:\\repo'), toUri('C:\\repo\\src\\alpha.ts'));

		// Assert
		expect(fsSpies.utimesSync.mock.calls.map(([filePath]) => filePath)).toEqual(['C:\\repo\\src\\alpha.ts', 'C:\\repo\\src']);
		expect(vscodeMock.Uri.file.mock.calls.map(([filePath]) => filePath)).toEqual(['C:\\repo\\src', 'C:\\repo']);
	});
});
