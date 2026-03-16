import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
	{
		ignores: ['out', 'node_modules', 'coverage', 'reports']
	},
	js.configs.recommended,
	...tseslint.configs.recommended
];
