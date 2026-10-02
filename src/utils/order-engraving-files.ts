// No storage/dependencies are opened for existing orders without attachments.
function storage() {
  const path = require('node:path');
  return require(path.join(process.cwd(), 'lib/engraving-files.cjs')).getStorage();
}
export function readEngravingFiles(body: any, hasEngraving: boolean) {
  if (body?.engravingFiles === undefined) return null;
  const value = body.engravingFiles;
  if (!hasEngraving || !value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !Array.isArray(value.ids) ||
      value.ids.length < 1 || value.ids.length > 3 || new Set(value.ids).size !== value.ids.length ||
      !value.ids.every((id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id))) {
    throw Error('invalid_engraving_files');
  }
  if (value.note !== undefined && (typeof value.note !== 'string' || value.note.length > 500)) throw Error('invalid_engraving_files');
  return { token: value.token, ids: value.ids as string[], note: (value.note || '').replace(/[\s|]+/g, ' ').trim() as string };
}
export function bindEngravingFiles(value: ReturnType<typeof readEngravingFiles>, key: string): string[] {
  if (!value) return [];
  const links = storage().bind(value.token, value.ids, key, process.env.ENGRAVING_PUBLIC_ORIGIN || 'https://api.cocktaildesign.ru');
  return value.note ? [...links, `Комментарий к макету: ${value.note}`] : links;
}
export function releaseEngravingFiles(key: string) { storage().unbind(key); }
export function completeEngravingFiles(key: string, id: string, name: string) { storage().complete(key, id, name); }
