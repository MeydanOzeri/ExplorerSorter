const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = [
	{
		ignores: ['out', 'node_modules']
	},
	js.configs.recommended,
	...tseslint.configs.recommended
];
