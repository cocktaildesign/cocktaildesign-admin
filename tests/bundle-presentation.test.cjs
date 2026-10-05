const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const mod = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/utils/bundle-presentation.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: mod, exports: mod.exports });
const { presentBundleItems } = mod.exports;
const item = () => ({ id: 1, quantity: '2', componentName: 'CRM name', componentType: 'variant',
  componentProduct: { id: 5, name: 'Родитель', slug: 'parent', price: 900, image: [{ url: '/parent.jpg' }] },
  componentVariant: { id: 8, name: 'Родитель (Серебро)', price: 700, product: { id: 5 }, image: [{ url: '/silver.jpg' }] },
});
test('variant identity, name, quantity, price and image are preserved', () => {
  const source = item(), before = JSON.stringify(source), out = presentBundleItems([source], false)[0];
  assert.equal(out.name, 'Родитель (Серебро)'); assert.equal(out.quantity, 2);
  assert.equal(out.componentProduct.variantId, 8); assert.equal(out.componentProduct.price, 700);
  assert.equal(out.componentProduct.imageUrl, '/silver.jpg'); assert.equal(JSON.stringify(source), before);
});
test('editorial switch hides all cards, preserving stored components', () => {
  const source = item(); assert.equal(presentBundleItems([source], true).length, 0); assert(source.componentVariant);
});
test('hidden, removed and moved components cannot link to an unrelated product/variant', () => {
  const rows = [item(), item(), item(), item()];
  rows[0].componentProduct.isHiddenOnSite = true; rows[1].componentProduct.isOutOfStock = true;
  rows[2].componentVariant = null; rows[3].componentVariant.product.id = 99;
  for (const row of rows) { const out = presentBundleItems([row], false)[0]; assert.equal(out.componentProduct, null); assert(out.name); }
});
test('missing catalog component keeps its name; variant photo falls back to parent', () => {
  const row = item(); row.componentVariant.image = [];
  assert.equal(presentBundleItems([row], false)[0].componentProduct.imageUrl, '/parent.jpg');
  row.componentVariant = null; row.componentProduct = null;
  assert.equal(presentBundleItems([row], false)[0].name, 'CRM name');
});
test('previous saved bundle rows remain compatible', () => {
  const row = item(); delete row.componentType; delete row.componentVariant; delete row.componentName;
  const out = presentBundleItems([row], false)[0];
  assert.equal(out.name, 'Родитель'); assert.equal(out.componentProduct.price, 900); assert.equal(out.componentProduct.variantId, null);
});
