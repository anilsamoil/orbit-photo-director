export async function fetchCatalog(url: string): Promise<unknown> {
  const loaded = await import(/* @vite-ignore */ url);
  if (!loaded || typeof loaded !== 'object' || !('default' in loaded)) {
    throw new Error('catalog import failed');
  }
  return loaded.default;
}
