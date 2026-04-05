'use strict';

/**
 * Default engine-model mappings — shared between dashboard routes and orchestrator.
 * Extracted from task-worker.js during ORCH-014 cut-over.
 */
const DEFAULT_ENGINE_MODELS = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.4',
  ollama: 'qwen3:4b',
};

module.exports = { DEFAULT_ENGINE_MODELS };
