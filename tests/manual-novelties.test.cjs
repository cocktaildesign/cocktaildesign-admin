const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, date, SAMPLE, ids } = require('./helpers/new-collection-fixture.cjs');

test('manual novelties extend the date rule without duplicates or bypassing visibility / Sample Sale', async () => {
  const f = fixture();
  f.collections[0].products = [1, 4, 8, 9, 10, 11, 999].map(id => ({ id }));
  const response = await f.list();
  assert.deepEqual(ids(response).sort((a, b) => a - b), [3, 4, 5, 6, 7, 8, 9, 12, 13, 15]);
  assert.equal(response.total, 10);
  assert.equal(response.items.filter(item => item.id === 4).length, 1);
  assert(response.items.every(item => item.attributes.isNew && !item.attributes.isSampleSale));
  assert.equal(response.items.at(-1).id, 3, 'Existing photo-first ordering is retained');
  assert.equal((await f.list({}, 'utsenka')).total, 4, 'Sample Sale remains available separately');
});

test('manual removal restores the ordinary expiry rule, changing days does not expire pinned items', async () => {
  const f = fixture();
  f.collections[0].products = [{ id: 8 }, { id: 4 }];
  f.collections[0].noveltyDays = 1;
  assert(ids(await f.list()).includes(8));
  f.collections[0].products = [];
  const afterRemoval = await f.list();
  assert(!ids(afterRemoval).includes(8));
  assert(ids(afterRemoval).includes(4), 'Recently created item stays automatically after unpinning');
  f.products.find(product => product.id === 4).moyskladNoveltyAt = date(2);
  assert(!ids(await f.list()).includes(4));
});

test('draft selections and day changes do not leak before publishing, including product badges', async () => {
  const f = fixture();
  const published = f.collections[0];
  published.products = [{ id: 8 }];
  f.collections.unshift({ ...published, id: 99, publishedAt: null, noveltyDays: 1000, products: [{ id: 9 }] });
  let response = await f.list();
  assert(ids(response).includes(8)); assert(!ids(response).includes(9));
  assert.equal((await f.invoke('productBySlug', { slug: 'item-8' })).item.attributes.isNew, true);
  assert.equal((await f.invoke('productBySlug', { slug: 'item-9' })).item.attributes.isNew, false);
  published.products = [{ id: 9 }];
  response = await f.list();
  assert(!ids(response).includes(8)); assert(ids(response).includes(9));
  published.publishedAt = null;
  assert.equal((await f.list()).error, 'collection_not_found');
  assert.equal((await f.invoke('productBySlug', { slug: 'item-9' })).item.attributes.isNew, false);
});

test('manual additions participate in category filters, counts and every page once', async () => {
  const f = fixture();
  f.collections[0].products = [{ id: 8 }, { id: 9 }];
  const all = await f.list({ limit: 100 });
  const pages = [];
  for (let offset = 0; offset < all.total; offset += 3) {
    const page = await f.list({ limit: 3, offset });
    assert.equal(page.total, all.total);
    assert.equal(page.hasMore, offset + page.items.length < all.total);
    pages.push(...ids(page));
  }
  assert.deepEqual(pages, ids(all)); assert.equal(new Set(pages).size, all.total);
  const tree = await f.invoke('collectionCategoriesTree');
  const category = tree.find(row => Number(row.id) === 10);
  assert.equal(category.productsCount, (await f.list({ categorySlug: 'ordinary' })).total);
  assert.equal(category.productsCount, 8);
  assert.equal((await f.list({ categorySlug: 'ordinary-child' })).total, 2);
  assert.equal((await f.list({ categorySlug: 'unknown-slug' })).total, 0);
});

test('catalog, favorites, product pages and both search mappings share the manual novelty badge', async () => {
  const f = fixture();
  f.collections[0].products = [{ id: 8 }, { id: 9 }, { id: 16 }];
  const catalog = await f.invoke('products', { categorySlug: 'ordinary', limit: 100 });
  for (const id of [8, 9]) assert.equal(catalog.items.find(item => item.id === id).attributes.isNew, true);
  const sale = await f.invoke('products', { categorySlug: 'sale', limit: 100 });
  assert.equal(sale.items.find(item => item.id === 16).attributes.isNew, false);
  for (const method of ['productsByIds', 'search']) {
    const response = await f.invoke(method, { ids: '8,9,16', q: 'Инструмент', count: 50, limit: 100 });
    for (const id of [8, 9, 16]) {
      const item = response.items.find(item => item.id === id);
      assert(item, method + ' includes ' + id);
      assert.equal(item.attributes.isNew, id !== 16, method + ': ' + id);
    }
  }
  for (const id of [8, 9, 16]) assert.equal(
    (await f.invoke('productBySlug', { slug: 'item-' + id })).item.attributes.isNew, id !== 16,
  );
  const { mapCatalogSearchV2Rows: map } = f.load('src/utils/catalog-search-v2-response');
  const { prepareCatalogSearchQuery: prepare } = f.load('src/utils/catalog-search-v2');
  const config = await f.load('src/utils/product-novelty').getProductNoveltyConfig(f.strapi);
  const mapped = map(f.products.filter(p => [8, 9, 16].includes(p.id)), prepare('Инструмент'), config, new Set([SAMPLE]));
  assert.deepEqual(Array.from(mapped, item => [item.id, item.attributes.isNew]), [[8, true], [9, true], [16, false]]);
  f.products.splice(0, f.products.length, ...f.products.filter(p => [8, 9, 16].includes(p.id)));
  const random = await f.invoke('randomProducts', { count: 6 });
  assert.deepEqual(random.items.map(item => [item.id, item.attributes.isNew]), [[8, true], [9, true], [16, false]]);
});

test('the nine Optic parents stay selected together; variant SKUs do not create duplicate cards', async () => {
  const f = fixture(); f.products.splice(0);
  const skus = ['JigHpn', 'JigMr', 'JigRtm', 'ShKorHpn', 'ShKorMr', 'ShKorRtm', 'MixHpn', 'MixMr', 'MixRtm'];
  f.products.push(...skus.map((code, index) => f.make(index + 101, 10, {
    code, moyskladNoveltyAt: date(index < 6 ? 300 : 30),
    variants: index < 3 ? [{ id: index + 501, code: code + '-25', price: 900, image: [] }] : [],
  })));
  f.collections[0].noveltyDays = 60;
  f.collections[0].products = f.products.map(({ id }) => ({ id }));
  assert.equal((await f.list()).total, 9);
  for (const product of f.products) product.moyskladNoveltyAt = date(1000);
  assert.equal((await f.list()).total, 9);
  assert.equal((await f.invoke('collectionCategoriesTree'))[0].productsCount, 9);
});

test('manual / category / discount modes keep existing membership and do not become novelty overrides', async () => {
  const f = fixture();
  f.collections[0].products = [{ id: 8 }];
  assert.deepEqual(ids(await f.list({}, 'manual')).sort((a, b) => a - b), [1, 4, 14]);
  assert.deepEqual(ids(await f.list({}, 'discounts')).sort((a, b) => a - b), [4, 16]);
  assert.deepEqual(ids(await f.list({}, 'utsenka')).sort((a, b) => a - b), [1, 2, 14, 16]);
  f.collections[0].selectionMode = 'manual';
  assert.deepEqual(ids(await f.list()), [8]);
  assert.equal((await f.invoke('productBySlug', { slug: 'item-8' })).item.attributes.isNew, false);
});

test('bad relation values cannot expand manual membership; Sample Sale always wins over pinning', () => {
  const { getManualNoveltyProductIds, isProductNew } = fixture().load('src/utils/product-novelty');
  assert.deepEqual(Array.from(getManualNoveltyProductIds([{ id: 8 }, { id: 8 }, null, {}, { id: '9' }, { id: -1 }])), [8]);
  assert.deepEqual(Array.from(getManualNoveltyProductIds(null)), []);
  assert.equal(isProductNew(null, 60, false, true), true);
  assert.equal(isProductNew(date(300), 60, true, true), false);
});
