import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	// Only host tests run here. The fast suites use the Node test runner via
	// `npm run test:unit` and must not be pulled into the VS Code instance.
	files: 'out/test/**/*.host.test.js',
});
