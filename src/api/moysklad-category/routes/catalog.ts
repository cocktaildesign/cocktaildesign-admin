// backend/src/api/moysklad-category/routes/catalog.ts

export default {
  routes: [
    {
      method: "GET",
      path: "/catalog/availability",
      handler: "availability.find",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/cart-discount-policy",
      handler: "cart-discount-policy.find",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/categories-flat",
      handler: "moysklad-category.categoriesFlat",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/products",
      handler: "moysklad-category.products",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/products-discounted",
      handler: "moysklad-category.productsDiscounted",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/products-by-ids",
      handler: "moysklad-category.productsByIds",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/product",
      handler: "moysklad-category.productBySlug",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/search",
      handler: "moysklad-category.search",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/search-v2",
      handler: "moysklad-category.searchV2",
      config: { auth: false },
    },
    {
      method: "GET",
      path: "/catalog/random-products",
      handler: "moysklad-category.randomProducts",
      config: { auth: false },
    },

    // ----------------------------------------------------------------------------
    // Коллекция: товары по slug коллекции
    // GET /api/catalog/collection/:slug/products
    // ----------------------------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/collection/:slug/products",
      handler: "moysklad-category.collectionProducts",
      config: { auth: false },
    },

    // ----------------------------------------------------------------------------
    // Коллекция: дерево категорий из товаров коллекции
    // GET /api/catalog/collection/:slug/categories-tree
    // ----------------------------------------------------------------------------
    {
      method: "GET",
      path: "/catalog/collection/:slug/categories-tree",
      handler: "moysklad-category.collectionCategoriesTree",
      config: { auth: false },
    },
  ],
};
