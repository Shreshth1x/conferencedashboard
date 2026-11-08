export class DeskError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const clean = (value: unknown, max = 400) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const token = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
export const expire = <T>(records: Record<string, T>, expired: (value: T) => boolean) => {
  for (const [id, value] of Object.entries(records)) if (expired(value)) delete records[id];
};
export async function hash(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
