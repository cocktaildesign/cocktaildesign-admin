const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const SAMPLE = 'b4121850-6ab7-11ef-0a80-01fa00116171';
const DAY = 86400000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const date = days => new Date(NOW - days * DAY).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const ids = body => Array.from(body.items, item => item.id);
class Clock extends Date { static now() { return NOW; } }

// Relation NULLs deliberately have SQL-style $notIn behavior: NULL is not a match.
// The production filter must retain them explicitly instead of accidentally hiding them.
function matches(row, where = {}) {
  if (Array.isArray(row)) return row.some(item => matches(item, where));
  return Object.entries(where).every(([key, expected]) => {
    if (key === '$and') return expected.every(value => matches(row, value));
    if (key === '$or') return expected.some(value => matches(row, value));
    const value = row?.[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (!Object.keys(expected).some(key => key.startsWith('$'))) return matches(value, expected);
      return Object.entries(expected).every(([op, operand]) => {
        if (op === '$null') return operand ? value == null : value != null;
        if (op === '$notNull') return operand ? value != null : value == null;
        if (op === '$in') return value != null && operand.includes(value);
        if (op === '$notIn') return value != null && !operand.includes(value);
        if (op === '$gte') return value != null && value >= operand;
        if (op === '$containsi') return typeof value === 'string' && value.toLowerCase().includes(operand.toLowerCase());
        throw Error('Unsupported fixture operator: ' + op);
      });
    }
    return value === expected;
  });
}

function fixture(options = {}) {
  const categories = options.categories ?? [
    { id: 1, name: 'Sample Sale renamed', slug: 'sale', moyskladId: SAMPLE, parent: null },
    { id: 2, name: 'Nested', slug: 'sale-child', moyskladId: 'sale-child-ms', parent: { id: 1 } },
    { id: 3, name: 'Deep', slug: 'sale-deep', moyskladId: 'sale-deep-ms', parent: { id: 2 } },
    { id: 10, name: 'Ordinary', slug: 'ordinary', moyskladId: 'ordinary-ms', parent: null },
    { id: 11, name: 'Ordinary child', slug: 'ordinary-child', moyskladId: 'ordinary-child-ms', parent: { id: 10 } },
    { id: 12, name: 'No CRM id', slug: 'unknown', moyskladId: null, parent: null },
  ];
  const byCategory = id => categories.find(category => category.id === id);
  const make = (id, categoryId = 10, extra = {}) => ({
    id, name: 'Инструмент ' + id, slug: 'item-' + id, code: 'SKU-' + id,
    category: categoryId === null ? null : byCategory(categoryId), type: 'product',
    price: 500, priceOld: null, isHiddenOnSite: false, isOutOfStock: false,
    moyskladCreatedAt: date(1), moyskladNoveltyAt: date(1),
    image: [{ url: '/uploads/item.webp' }], variants: [], ...extra,
  });
  const products = options.products ?? [
    make(1, 1), make(2, 3, { variants: [{ id: 201, code: 'VAR-SALE', price: 400, image: [] }] }),
    make(3, 10, { image: [] }), make(4, 10, { priceOld: 800 }),
    make(5, 11, { discountExcluded: true }), make(6, null), make(7, 12),
    make(8, 10, { moyskladNoveltyAt: date(101) }), make(9, 10, { moyskladNoveltyAt: null }),
    make(10, 10, { isHiddenOnSite: true }), make(11, 1, { isOutOfStock: true }),
    make(12, 11, { moyskladCreatedAt: date(200), variants: [{ id: 1201, code: 'VAR-REG', price: 700, moyskladCreatedAt: date(1), image: [] }] }),
    make(13, 10, { type: 'bundle' }), make(14, 2, { type: 'bundle' }),
    make(15, 10, { name: 'Инструмент (уцененный)', discountExcluded: true }),
    make(16, 1, { priceOld: 900, moyskladNoveltyAt: date(200) }),
  ];
  const collections = (options.collections ?? [
    { id: 1, slug: 'novinki', selectionMode: 'new', noveltyDays: 100, noveltyBadgeColor: '#2eae4a' },
    { id: 2, slug: 'utsenka', selectionMode: 'category', sourceCategory: byCategory(1) },
    { id: 3, slug: 'manual', selectionMode: 'manual', products: [{ id: 1 }, { id: 4 }, { id: 14 }] },
    { id: 4, slug: 'discounts', selectionMode: 'discount' },
    { id: 5, slug: 'another-new', selectionMode: 'new', noveltyDays: 60 },
  ]).map(collection => ({ publishedAt: date(1), ...collection }));
  const calls = [];
  const strapi = { log: { info() {}, warn() {}, error() {} }, db: { query(uid) {
    const rows = uid === 'api::catalog-collection.catalog-collection' ? collections :
      uid === 'api::moysklad-product.moysklad-product' ? products :
      uid === 'api::moysklad-category.moysklad-category' ? categories : null;
    assert(rows, 'Unexpected table: ' + uid);
    const select = args => {
      calls.push({ uid, ...args });
      let selected = rows.filter(row => matches(row, args.where));
      for (const order of (Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : []).slice().reverse()) {
        const [key, direction] = Object.entries(order)[0];
        selected.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (direction === 'desc' ? -1 : 1));
      }
      const offset = args.offset ?? 0;
      return plain(selected.slice(offset, args.limit === undefined ? undefined : offset + args.limit));
    };
    return new Proxy({ findMany: async args => select(args), findOne: async args => select(args)[0] ?? null,
      count: async args => rows.filter(row => matches(row, args.where)).length }, {
      get(target, key) { assert(key in target, 'Database writes are forbidden: ' + String(key)); return target[key]; },
    });
  } } };
  const cache = new Map();
  const context = vm.createContext({ Date: Clock, Math: Object.assign(Object.create(Math), { random: () => 0 }),
    strapi, process: { env: {} }, console: { log() {}, warn() {}, error() {} },
    fetch() { throw Error('Network is forbidden'); }, URLSearchParams });
  function load(file) {
    file = path.resolve(root, file.endsWith('.ts') ? file : file + '.ts');
    assert(file.startsWith(root + path.sep), 'Module outside fixture');
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText;
    const localRequire = name => {
      if (name === 'node:crypto') return require('node:crypto');
      if (name === '@strapi/strapi') return { factories: { createCoreController: (_uid, factory) => factory({ strapi }) } };
      if (name === '../services/sync') return () => { throw Error('Sync cannot run in this test'); };
      assert(name.startsWith('.'), 'External dependency blocked: ' + name);
      return load(path.resolve(path.dirname(file), name));
    };
    vm.runInContext('(function(require,module,exports){' + source + '\n})', context, { timeout: 1000 })(localRequire, module, module.exports);
    return module.exports;
  }
  const controller = load('src/api/moysklad-category/controllers/moysklad-category').default;
  async function invoke(method, query = {}, slug = 'novinki') {
    const before = JSON.stringify({ products, categories, collections });
    const ctx = { params: { slug }, query };
    await controller[method](ctx);
    assert.equal(JSON.stringify({ products, categories, collections }), before, 'Read API must not mutate source records');
    return plain(ctx.body);
  }
  return { products, categories, collections, calls, make, load, invoke, controller, strapi,
    list: (query = {}, slug = 'novinki') => invoke('collectionProducts', query, slug) };
}


module.exports = { fixture, date, DAY, NOW, Clock, SAMPLE, ids };
