export function browserPidSnapshot(): Set<number>;
export function browserPidsLaunchedSince(before: ReadonlySet<number>): number[];
export function closeBrowser(browser: { close(): Promise<unknown> } | undefined, rootPids: readonly number[], label?: string): Promise<void>;
