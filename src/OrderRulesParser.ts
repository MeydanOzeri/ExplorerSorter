import type { OrderRule } from './types/OrderRule.ts';

import { workspace, Uri } from 'vscode';

class OrderRulesParser {
	static #textDecoder = new TextDecoder();

	static #normalizePath = (path: string) =>
		path
			.trim()
			.replaceAll('\\', '/')
			.replace(/^\.\/+/g, '')
			.replace(/\/+$/g, '');

	static #parseOrderFile = async (orderFile: Uri): Promise<OrderRule[]> => {
		const orderContent = await workspace.fs.readFile(orderFile);
		return this.#textDecoder
			.decode(orderContent)
			.split(/\r?\n/)
			.map((orderLine) => {
				const line = this.#normalizePath(orderLine);
				const lineType: 'glob' | 'exact' = /[*?[\]{}]/.test(line) ? 'glob' : 'exact';
				return { line, lineType };
			})
			.filter(({ line }) => line.length > 0 && !line.startsWith('#'));
	};

	static getOrderRules = async (parentOrderRules: OrderRule[], currentDirectory: Uri, directoryFiles: string[]): Promise<OrderRule[]> => {
		if (!directoryFiles.includes('.order')) {
			return parentOrderRules;
		}
		const orderFileLines = await this.#parseOrderFile(Uri.joinPath(currentDirectory, '.order'));
		return [...orderFileLines, ...parentOrderRules];
	};
}

export default OrderRulesParser;
