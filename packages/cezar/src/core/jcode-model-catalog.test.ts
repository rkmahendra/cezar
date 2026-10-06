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
