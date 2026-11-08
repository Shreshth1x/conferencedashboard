export async function api<T>(route: string, body?: object): Promise<T> {
  const result = await fetch('/api' + route, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await result.json();
  if (!result.ok) throw new Error(value.error || 'The request failed. Try again.');
  return value as T;
}
