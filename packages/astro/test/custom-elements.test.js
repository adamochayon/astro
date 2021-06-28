import { suite } from 'uvu';
import * as assert from 'uvu/assert';
import { doc } from './test-utils.js';
import { setup } from './helpers.js';

const CustomElements = suite('Custom Elements');

setup(CustomElements, './fixtures/custom-elements');

CustomElements('Work as constructors', async ({ runtime }) => {
  const result = await runtime.load('/ctr');
  if (result.error) throw new Error(result.error);

  const $ = doc(result.contents);
  assert.equal($('my-element').length, 1, 'Element rendered');
  assert.equal($('my-element template[shadowroot=open]').length, 1, 'shadow rendered');
});

CustomElements.skip('Works with exported tagName', async ({ runtime }) => {
  const result = await runtime.load('/');
  if (result.error) throw new Error(result.error);

  console.log(result);
  const $ = doc(result.contents);
  assert.equal($('my-element').length, 1, 'Element rendered');
  assert.equal($('my-element template[shadowroot=open]').length, 1, 'shadow rendered');
});

CustomElements.skip('Hydration works with exported tagName', async ({ runtime }) => {

});

CustomElements('Custom elements not claimed by renderer are rendered as regular HTML', async ({ runtime }) => {
  const result = await runtime.load('/nossr');
  if (result.error) throw new Error(result.error);

  const $ = doc(result.contents);
  assert.equal($('client-element').length, 1, 'Rendered the client-only element');
});

CustomElements.run();
