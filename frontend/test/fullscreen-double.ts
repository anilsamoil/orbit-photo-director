/** Which Fullscreen API the double gives happy-dom, which ships none. 'both' fires the standard and the webkit change event for one change. */
export type FullscreenApi = 'standard' | 'webkit' | 'both' | 'missing';

export type FullscreenDouble = {
  /** What `fullscreenElement`, or its webkit twin, reports now. */
  current(): Element | null;
  /** Settles the oldest open request. The element becomes current and this API's change events fire. */
  grant(): void;
  /** Settles the oldest open request as refused. The standard API rejects and the webkit API fires `webkitfullscreenerror`. */
  refuse(): void;
  /** The browser leaves fullscreen by itself, as after its own Escape. */
  leave(): void;
  /** Removes everything the install added. */
  restore(): void;
};

type OpenRequest = { element: Element; settle(granted: boolean): void };

/**
 * Installs the members the ISS fullscreen toggle feature-detects on
 * `Element.prototype` and `document`. Requests stay open until the test settles
 * them. An exit settles on the next microtask, clearing `current` and firing
 * this API's change events.
 */
export function installFullscreenDouble(api: FullscreenApi): FullscreenDouble {
  const standard = api === 'standard' || api === 'both';
  const webkit = api === 'webkit' || api === 'both';
  const open: OpenRequest[] = [];
  const installed: { target: object; name: string }[] = [];
  let current: Element | null = null;

  function install(target: object, name: string, descriptor: PropertyDescriptor): void {
    Object.defineProperty(target, name, { configurable: true, ...descriptor });
    installed.push({ target, name });
  }

  function changed(element: Element): void {
    const target: EventTarget = element.isConnected ? element : document;
    if (standard) target.dispatchEvent(new Event('fullscreenchange', { bubbles: true, composed: true }));
    if (webkit) target.dispatchEvent(new Event('webkitfullscreenchange', { bubbles: true, composed: true }));
  }

  function exit(): Promise<void> {
    const element = current;
    if (!element) return Promise.reject(new TypeError('Not in fullscreen'));
    return Promise.resolve().then(() => {
      if (current !== element) return;
      current = null;
      changed(element);
    });
  }

  function oldest(): OpenRequest {
    const request = open.shift();
    if (!request) throw new Error('no open fullscreen request');
    return request;
  }

  if (standard) {
    install(Element.prototype, 'requestFullscreen', {
      writable: true,
      value(this: Element): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          open.push({ element: this, settle: (granted) => (granted ? resolve() : reject(new TypeError('Fullscreen request denied'))) });
        });
      },
    });
    install(document, 'exitFullscreen', { writable: true, value: exit });
    install(document, 'fullscreenElement', { get: () => current });
  }
  if (webkit) {
    install(Element.prototype, 'webkitRequestFullscreen', {
      writable: true,
      value(this: Element): void {
        open.push({
          element: this,
          settle: (granted) => {
            if (!granted) this.dispatchEvent(new Event('webkitfullscreenerror', { bubbles: true }));
          },
        });
      },
    });
    install(document, 'webkitExitFullscreen', {
      writable: true,
      value: () => {
        exit().catch(() => undefined);
      },
    });
    install(document, 'webkitFullscreenElement', { get: () => current });
  }

  return {
    current: () => current,
    grant() {
      const request = oldest();
      current = request.element;
      changed(request.element);
      request.settle(true);
    },
    refuse() {
      oldest().settle(false);
    },
    leave() {
      const element = current;
      if (!element) throw new Error('not in fullscreen');
      current = null;
      changed(element);
    },
    restore() {
      for (const { target, name } of installed.splice(0).reverse()) Reflect.deleteProperty(target, name);
      open.length = 0;
      current = null;
    },
  };
}
