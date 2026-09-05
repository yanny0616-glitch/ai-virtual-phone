const values = new Map<string, string>();
export const kvGet = (key: string) => values.get(key) || null;
export const kvSet = (key: string, value: string) => { values.set(key, value); };
export const kvRemove = (key: string) => { values.delete(key); };
export const registerKvMigration = () => undefined;
export const registerDynamicPrefix = () => undefined;
