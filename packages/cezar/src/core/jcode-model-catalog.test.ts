import { expect, it } from 'vitest';
import { jcodeModelOptions } from './jcode-model-catalog.ts';

// Shape from a live `jcode acp` session/new (0.91.0): configOptions[{id:'model', currentValue, options}].
it('lists jcode models with the daemon default first', () => {
  const models = jcodeModelOptions({
    configOptions: [
      { id: 'model', currentValue: 'cc/x', options: [{ name: 'gpt-5.4', value: 'gpt-5.4' }, { name: 'cc/x', value: 'cc/x' }, { value: 'gpt-5.4' }, { value: ' ' }] },
    ],
  });
  expect(models).toEqual([
    { id: 'cc/x', label: 'cc/x', description: 'jcode default' },
    { id: 'gpt-5.4', label: 'gpt-5.4', description: '' },
  ]);
  // Absent list fails loud, so the catalog reports "unavailable" instead of an empty picker.
  expect(() => jcodeModelOptions({})).toThrow();
});

// Picking a jcode model used to silently revert to auto: bare `claude-…`/`gpt-…` ids were judged
// "another runner's", and `cc/…` route ids threw as a foreign provider.
it('accepts every jcode catalog id shape end to end', async () => {
  const { modelConflictsWithRunner } = await import('./model-presets.ts');
  const { normalizeModelForBackend } = await import('./model-identity.ts');
  for (const id of ['claude-opus-5', 'gpt-5.4', 'kimi-k3', 'cc/claude-opus-5-5', 'accounts/fireworks/models/glm-4p7']) {
    expect(modelConflictsWithRunner(id, 'jcode')).toBe(false);
    expect(normalizeModelForBackend('jcode', id)?.backendModel).toBe(id);
  }
  // The guard still protects the single-vendor runners.
  expect(modelConflictsWithRunner('gpt-5.4', 'claude')).toBe(true);
});
