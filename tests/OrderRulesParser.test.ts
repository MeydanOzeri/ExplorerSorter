import type { Uri } from 'vscode';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toDirectoryUri = (fsPath: string) => ({ fsPath, path: fsPath }) as unknown as Uri;

const vscodeMock = vi.hoisted(() => {
	const joinPath = (...parts: string[]) => parts.join('/').replace(/\/+/g, '/').replace(/\/\//g, '/');
	const toUri = (fsPath: string) => ({
		fsPath,
		path: fsPath.replaceAll('\\', '/'),
		toString: () => fsPath
	});

	return {
		workspace: {
			fs: {
				readFile: vi.fn()
			}
		},
		Uri: {
			joinPath: vi.fn((base: { fsPath: string }, ...segments: string[]) => toUri(joinPath(base.fsPath, ...segments)))
		}
	};
});

vi.mock('vscode', () => vscodeMock);

describe('OrderRulesParser', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns parent rules when local order file is missing', async () => {
		// Arrange
		const { default: OrderRulesParser } = await import('../src/OrderRulesParser.ts');
		const parentRules = [{ line: 'src/app.ts', lineType: 'exact' as const }];

		// Act
		const result = await OrderRulesParser.getOrderRules(parentRules, toDirectoryUri('C:/repo/src'), ['index.ts']);

		// Assert
		expect(result).toBe(parentRules);
		expect(vscodeMock.workspace.fs.readFile).not.toHaveBeenCalled();
	});

	it('parses and appends local order rules', async () => {
		// Arrange
		const { default: OrderRulesParser } = await import('../src/OrderRulesParser.ts');
		vscodeMock.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('\n# comment\n  .\\src\\app.ts  \n**/*.test.ts\nfolder///\n\n'));

		// Act
		const result = await OrderRulesParser.getOrderRules([], toDirectoryUri('C:/repo'), ['.order', 'src']);

		// Assert
		expect(vscodeMock.workspace.fs.readFile).toHaveBeenCalledOnce();
		expect(vscodeMock.Uri.joinPath).toHaveBeenCalledWith({ fsPath: 'C:/repo', path: 'C:/repo' }, '.order');
		expect(result).toEqual([
			{ line: 'src/app.ts', lineType: 'exact' },
			{ line: '**/*.test.ts', lineType: 'glob' },
			{ line: 'folder', lineType: 'exact' }
		]);
	});

	it('keeps local rules before inherited parent rules', async () => {
		// Arrange
		const { default: OrderRulesParser } = await import('../src/OrderRulesParser.ts');
		vscodeMock.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('docs/**/*.md'));
		const parentRules = [{ line: 'src', lineType: 'exact' as const }];

		// Act
		const result = await OrderRulesParser.getOrderRules(parentRules, toDirectoryUri('C:/repo/docs'), ['.order']);

		// Assert
		expect(result).toEqual([
			{ line: 'docs/**/*.md', lineType: 'glob' },
			{ line: 'src', lineType: 'exact' }
		]);
	});

	it('keeps comment-only and empty local files from adding rules', async () => {
		// Arrange
		const { default: OrderRulesParser } = await import('../src/OrderRulesParser.ts');
		const parentRules = [{ line: 'root', lineType: 'exact' as const }];
		vscodeMock.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('\n# one\n   \n# two\n'));

		// Act
		const result = await OrderRulesParser.getOrderRules(parentRules, toDirectoryUri('C:/repo/child'), ['.order']);

		// Assert
		expect(result).toEqual(parentRules);
	});

	it('only removes leading dot-slash segments and keeps internal dot-slash text', async () => {
		// Arrange
		const { default: OrderRulesParser } = await import('../src/OrderRulesParser.ts');
		vscodeMock.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode('.///leading.ts\nfolder/./kept.ts\n'));

		// Act
		const result = await OrderRulesParser.getOrderRules([], toDirectoryUri('C:/repo'), ['.order']);

		// Assert
		expect(result).toEqual([
			{ line: 'leading.ts', lineType: 'exact' },
			{ line: 'folder/./kept.ts', lineType: 'exact' }
		]);
	});

	it('loads the order rule types module', async () => {
		// Arrange
		const importOrderRuleModule = () => import('../src/types/OrderRule.ts');

		// Act
		const orderRuleModule = await importOrderRuleModule();

		// Assert
		expect(orderRuleModule).toBeDefined();
	});
});
