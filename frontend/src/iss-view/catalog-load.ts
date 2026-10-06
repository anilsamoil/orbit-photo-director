export async function fetchCatalog(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
