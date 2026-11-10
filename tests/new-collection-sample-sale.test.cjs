const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, date, DAY, NOW, Clock, SAMPLE, ids } = require('./helpers/new-collection-fixture.cjs');

test('new collection excludes the Sample Sale tree before totals, paging and photo ordering', async () => {
  const f = fixture();
  const first = await f.list({ limit: 3 });
  assert.deepEqual(ids(first), [15, 13, 12]);
  assert.equal(first.total, 8); assert.equal(first.hasMore, true);
  const rest = await f.list({ limit: 100, offset: 3 });
  assert.deepEqual(ids(rest), [7, 6, 5, 4, 3]); assert.equal(rest.hasMore, false);
  assert.equal(rest.items.at(-1).attributes.isNew, true, 'No photo does not hide a normal novelty');
  const tail = await f.list({ offset: 99 }); assert.equal(tail.total, 8); assert.deepEqual(ids(tail), []);
  for (const response of [first, rest]) for (const item of response.items) {
    assert.equal(item.attributes.isSampleSale, false); assert.equal(item.attributes.isNew, true);
  }
});

test('category counts and category filters use the same new membership; Sample Sale remains in its own collection', async () => {
  const f = fixture();
  const tree = await f.invoke('collectionCategoriesTree');
  assert.deepEqual(tree.map(category => Number(category.id)).sort((a, b) => a - b), [10, 11, 12]);
  assert.equal(tree.find(category => Number(category.id) === 10).productsCount, 6);
  assert.equal(tree.find(category => Number(category.id) === 11).productsCount, 2);
  assert.equal(tree.find(category => Number(category.id) === 12).productsCount, 1);
  assert.equal((await f.list({ categorySlug: 'sale' })).total, 0);
  assert.equal((await f.list({ categorySlug: 'sale-deep' })).total, 0);
  assert.deepEqual(ids(await f.list({ categorySlug: 'ordinary' })), [15, 13, 12, 5, 4, 3]);
  assert.deepEqual(ids(await f.list({}, 'utsenka')).sort((a, b) => a - b), [1, 2, 14, 16]);
  assert((await f.list({}, 'utsenka')).items.every(item => item.attributes.isSampleSale && !item.attributes.isNew));
  const saleCategory = await f.invoke('products', { categorySlug: 'sale' });
  assert.deepEqual(ids(saleCategory), [16, 14, 2, 1]);
  assert(saleCategory.items.every(item => item.attributes.isNew === false));
});

test('manual, category and discount membership keep their products; all new-mode collections exclude Sample Sale', async () => {
  const f = fixture();
  assert.deepEqual(ids(await f.list({}, 'manual')).sort((a, b) => a - b), [1, 4, 14]);
  assert.deepEqual(ids(await f.list({}, 'discounts')).sort((a, b) => a - b), [4, 16]);
  f.products.push(f.make(17, 10, { moyskladNoveltyAt: date(80) }));
  assert(ids(await f.list()).includes(17));
  const other = await f.list({}, 'another-new');
  assert(!ids(other).includes(17)); assert.equal(other.total, 8);
  assert(other.items.every(item => !item.attributes.isSampleSale));
});

test('moving products and adding a descendant applies on next read without resetting dates or other data', async () => {
  const f = fixture();
  const product = f.products.find(row => row.id === 4), originalDate = product.moyskladNoveltyAt;
  product.category = f.categories[2];
  assert(!ids(await f.list()).includes(4));
  assert(ids(await f.list({}, 'utsenka')).includes(4));
  product.category = f.categories.find(category => category.id === 10);
  assert(ids(await f.list()).includes(4)); assert.equal(product.moyskladNoveltyAt, originalDate);
  f.categories.push({ id: 4, name: 'New descendant', slug: 'new-child', moyskladId: 'new-child-ms', parent: { id: 3 } });
  f.products.push(f.make(99, 4));
  assert(!ids(await f.list()).includes(99)); assert(ids(await f.list({}, 'utsenka')).includes(99));
});

test('the complete filtered pool spans multiple DB batches and produces gap-free pages', async () => {
  const f = fixture(); f.products.splice(0);
  for (let id = 1; id <= 710; id++) f.products.push(f.make(id, id % 3 === 0 ? 3 : 10, { image: id % 2 ? [{ url: '/photo.webp' }] : [] }));
  const expected = [...f.products.filter(p => p.id % 3 && p.id % 2).reverse(), ...f.products.filter(p => p.id % 3 && !(p.id % 2)).reverse()].map(p => p.id);
  const actual = [];
  for (let offset = 0; offset < expected.length; offset += 100) {
    const result = await f.list({ limit: 100, offset });
    assert.equal(result.total, expected.length); assert.equal(result.hasMore, offset + result.items.length < expected.length);
    actual.push(...ids(result));
  }
  assert.deepEqual(actual, expected); assert.equal(new Set(actual).size, expected.length);
  const tree = await f.invoke('collectionCategoriesTree'); assert.equal(tree.length, 1); assert.equal(tree[0].productsCount, expected.length);
});

test('catalog cards, favorites, product detail and both search mappings agree on the novelty badge', async () => {
  const f = fixture();
  for (const method of ['productsByIds', 'search', 'randomProducts']) {
    const result = await f.invoke(method, { ids: '1,2,4,12,13,14', q: 'Инструмент', count: 6 });
    assert(result.items.some(item => item.attributes.isSampleSale), method + ' must keep Sample Sale');
    assert(result.items.every(item => !item.attributes.isSampleSale || item.attributes.isNew === false), method);
  }
  for (const id of [1, 2, 4, 12, 13, 14]) {
    const result = await f.invoke('productBySlug', { slug: 'item-' + id });
    assert.equal(result.item.attributes.isNew, [4, 12, 13].includes(id));
  }
  const { mapCatalogSearchV2Rows: map } = f.load('src/utils/catalog-search-v2-response');
  const { prepareCatalogSearchQuery: prepare } = f.load('src/utils/catalog-search-v2');
  const mapped = map(f.products.filter(p => [1, 2, 4, 12, 13, 14].includes(p.id)), prepare('VAR-SALE'),
    { noveltyDays: 100, noveltyBadgeColor: '#2eae4a' }, new Set([SAMPLE, 'sale-child-ms', 'sale-deep-ms']));
  assert.deepEqual(Array.from(mapped, row => [row.id, row.attributes.isNew]), [[1, false], [2, false], [4, true], [12, true], [13, true], [14, false]]);
  assert.equal(mapped.find(row => row.id === 2).attributes.matchedVariant.code, 'VAR-SALE');
});

test('novelty date boundaries and configurable days remain unchanged for ordinary products', () => {
  const f = fixture(), { isProductNew: isNew } = f.load('src/utils/product-novelty');
  assert.equal(isNew(date(100), 100, false), true);
  assert.equal(isNew(new Clock(NOW - 100 * DAY - 1).toISOString(), 100, false), false);
  assert.equal(isNew(date(80), 60, false), false); assert.equal(isNew(date(80), 100, false), true);
  assert.equal(isNew(date(80), 0, false), true, 'Invalid days still use 100-day default');
  for (const value of [null, undefined, '', 'invalid']) assert.equal(isNew(value, 100, false), false);
  for (const value of [date(0), date(1), date(100)]) assert.equal(isNew(value, 100, true), false);
});

test('a new collection with only Sample Sale has an honest empty page and no category facets', async () => {
  const f = fixture(); f.products.splice(0, f.products.length, f.make(1, 1), f.make(2, 3));
  const result = await f.list();
  assert.deepEqual(ids(result), []); assert.equal(result.total, 0); assert.equal(result.hasMore, false);
  assert.deepEqual(await f.invoke('collectionCategoriesTree'), []);
  assert.equal((await f.list({}, 'utsenka')).total, 2);
});
