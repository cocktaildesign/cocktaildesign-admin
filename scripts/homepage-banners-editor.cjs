// One-time editor configuration, called explicitly by the reviewed release script.
// Does not publish homepage data or modify other content types.
module.exports = async function configureHomepageBanners(strapi) {
  const snapshots = {};
  for (const [uid, serviceName, modelName] of [
    ['api::homepage.homepage', 'content-types', 'findContentType'],
    ['homepage.hero-banner', 'components', 'findComponent'],
    ['homepage.promo-banner', 'components', 'findComponent'],
  ]) {
    const service = strapi.plugin('content-manager').service(serviceName);
    const model = service[modelName](uid);
    const before = await service.findConfiguration(model);
    snapshots[uid] = structuredClone(before);
    const next = structuredClone(before);
    const schema = uid.startsWith('api::') ? strapi.contentTypes[uid] : strapi.components[uid];
    for (const [field, metadata] of Object.entries(schema.config.metadatas)) {
      next.metadatas[field].edit = {...next.metadatas[field].edit, ...metadata.edit};
    }
    if (serviceName === 'components') {
      next.settings.mainField = 'title';
      next.layouts.edit = ['title', 'desktopImage', 'mobileImage', 'href', 'isActive']
        .map(name => [{name, size:12}]);
    } else {
      const oldRows = next.layouts.edit.map(row => row.filter(field => !['heroBanners','promoBanners'].includes(field.name))).filter(row => row.length);
      next.layouts.edit = [[{name:'heroBanners',size:12}], [{name:'promoBanners',size:12}], ...oldRows];
    }
    await service.updateConfiguration(model, next);
  }
  return snapshots;
};
