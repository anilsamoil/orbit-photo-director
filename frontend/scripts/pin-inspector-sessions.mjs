import { closeBrowser } from '../test/close-browser.mjs';

export async function openPinnedBrowsers(launchWebKit, launchChrome, body) {
  let webKitSession;
  let desktopSession;
  try {
    webKitSession = await launchWebKit();
    desktopSession = await launchChrome();
    return await body(webKitSession, desktopSession);
  } finally {
    await closeBrowser(webKitSession, 'pin-inspector-webkit');
    await closeBrowser(desktopSession, 'pin-inspector-chrome');
  }
}
