'use strict';

/**
 * engine-resolver.js — Model alias expansion, provider inference, fallback chain
 *
 * Aliases:  sonnet → claude-sonnet-4-6  |  opus → claude-opus-4-6  |  haiku → claude-haiku-4-5
 * Inference: claude-* → claude  |  gpt-* → codex  |  anything else → ollama
 * Fallback chain: claude → codex → ollama
 */

const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-6',
  haiku:  'claude-haiku-4-5',
};

const ENGINE_CHAIN = ['claude', 'codex', 'ollama'];

/**
 * Expand a model alias to its full ID. Returns the input unchanged if unknown.
 * @param {string|null} model
 * @returns {string|null}
 */
function resolveModel(model) {
  if (!model) return null;
  return MODEL_ALIASES[model] || model;
}

/**
 * Infer engine from model name when no explicit engine is set.
 * @param {string|null} model
 * @returns {string}
 */
function inferEngine(model) {
  if (!model) return 'claude';
  const m = resolveModel(model);
  if (m.startsWith('claude-')) return 'claude';
  if (/^(gpt-|o1|o3|o4)/.test(m)) return 'codex';
  return 'ollama';
}

/**
 * Resolve engine + model from a DB task row.
 * Explicit task.engine takes precedence over inference.
 *
 * @param {object} task — DB task row (fields: engine, model)
 * @returns {{ engine: string, model: string|null }}
 */
function resolve(task) {
  const engine = task.engine || inferEngine(task.model);
  const model  = resolveModel(task.model);
  return { engine, model };
}

/**
 * Return the next engine in the fallback chain, or null if already at the end.
 * @param {string} engine
 * @returns {string|null}
 */
function nextEngine(engine) {
  const idx = ENGINE_CHAIN.indexOf(engine);
  if (idx < 0 || idx >= ENGINE_CHAIN.length - 1) return null;
  return ENGINE_CHAIN[idx + 1];
}

module.exports = { resolve, resolveModel, inferEngine, nextEngine, MODEL_ALIASES, ENGINE_CHAIN };
