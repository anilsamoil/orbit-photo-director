export function openPinnedBrowsers<WebKit, Chrome, Result>(
  launchWebKit: () => Promise<WebKit>,
  launchChrome: () => Promise<Chrome>,
  body: (webKit: WebKit, chrome: Chrome) => Promise<Result>,
): Promise<Result>;
