export function reloadSettled(
  send: (method: string, params?: { expression?: string; timeout?: number }) => Promise<unknown>,
): Promise<void>;
