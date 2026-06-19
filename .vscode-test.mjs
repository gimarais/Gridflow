import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code Extension Host (via @vscode/test-electron),
// so the `vscode` module, workspace.fs, and a real workspace folder are all available.
// `test-workspace/` is opened as the folder, giving workflowStore a place to write the
// `.gridflow/*.json` sidecars that the orchestrator/persistence tests exercise.
export default defineConfig({
  // tsconfig.test.json rootDir is the repo root, so compiled test output lands
  // under out/src/test/.
  files: 'out/**/*.test.js',
  workspaceFolder: './test-workspace',
  mocha: {
    ui: 'bdd',
    timeout: 20000,
    color: true,
  },
});
