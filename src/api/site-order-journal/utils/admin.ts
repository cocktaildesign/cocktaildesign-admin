import { AsyncLocalStorage } from 'node:async_hooks';
import { errors } from '@strapi/utils';

const UID = 'api::site-order-journal.site-order-journal' as any;
const internalWrite = new AsyncLocalStorage<boolean>();
export const createJournal = (data: any) => internalWrite.run(true, () => strapi.documents(UID).create({ data }));

export function registerJournalProtection(app: any) {
  app.documents.use(async (context: any, next: any) => {
    if (context.uid !== UID || internalWrite.getStore()) return next();
    if (context.action === 'update') {
      // Content Manager submits all visible fields, including unchanged read-only values.
      // Only these two manager fields may reach the write query.
      const input = context.params.data ?? {};
      context.params.data = Object.fromEntries(['handled', 'managerNote'].filter(key => key in input).map(key => [key, input[key]]));
    } else if (!['findOne', 'findMany', 'findFirst', 'count'].includes(context.action)) {
      throw new errors.ForbiddenError('Заявки создаются только при оформлении заказа. Удаление отключено.');
    }
    return next();
  });
}

export async function configureJournalAdmin(app: any) {
  const service = app.plugin('content-manager').service('content-types');
  const model = app.contentTypes[UID];
  const config = await service.findConfiguration(model);
  const labels: Record<string, string> = { number: 'Номер заявки', crmState: 'Передача в CRM', details: 'Состав и контакты',
    handled: 'Обработана менеджером', managerNote: 'Комментарий менеджера', createdAt: 'Получена',
    crmOrderName: 'Номер в МойСклад', purgedAt: 'Персональные данные удалены' };
  const metadatas = { ...config.metadatas };
  for (const [key, metadata] of Object.entries(metadatas) as [string, any][]) {
    metadatas[key] = { ...metadata,
      edit: { ...metadata.edit, label: labels[key] || key, editable: ['handled', 'managerNote'].includes(key), visible: key in labels },
      list: { ...metadata.list, label: labels[key] || key } };
  }
  const next = { ...config, settings: { ...config.settings, mainField: 'number', defaultSortBy: 'createdAt', defaultSortOrder: 'DESC', bulkable: false, pageSize: 25 },
    metadatas, layouts: { ...config.layouts,
      list: ['number', 'crmState', 'handled', 'createdAt'],
      edit: [[{ name: 'number', size: 6 }, { name: 'crmState', size: 6 }], [{ name: 'details', size: 12 }],
        [{ name: 'handled', size: 6 }, { name: 'crmOrderName', size: 6 }], [{ name: 'managerNote', size: 12 }],
        [{ name: 'createdAt', size: 6 }, { name: 'purgedAt', size: 6 }]] } };
  if (JSON.stringify(config) !== JSON.stringify(next)) await service.updateConfiguration(model, next);
}
