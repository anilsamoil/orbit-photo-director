/** Sun + sunspots widget — Pettit feedback 2026-05-19.
 *
 *  Don Pettit asked for "a link to sun image showing sunspots (for your inner
 *  solar photographer)." Mirrors the v1.2.3.0 Kp widget pattern: small badge
 *  on the topbar, click-through to a full sun-disk image.
 *
 *  Data path:
 *    NOAA SWPC SDO HMI continuum (visible-light, shows sunspots clearly)
 *      https://services.swpc.noaa.gov/images/animations/sdo-hmiif/latest.jpg
 *    No worker proxy in v1 — the image is small (~50KB), browser caches,
 *    SWPC updates ~every 15 min. If/when the operator needs offline access,
 *    we can add Worker-side caching like /api/kp.
 *
 *  Failure handling: the widget is OPTIONAL. On any fetch / load error the
 *  badge stays hidden. No banner, no error toast. Operator can always
 *  click through to the SWPC sun page if they want it directly.
 */

export const SWPC_SUN_IMAGE_URL =
  'https://services.swpc.noaa.gov/images/animations/sdo-hmiif/latest.jpg';

/** SWPC's sun-imagery dashboard page. Clicking the widget opens this so the
 *  operator can see the live image larger + browse other wavelengths. */
export const SWPC_SUN_DASHBOARD_URL =
  'https://www.swpc.noaa.gov/products/solar-and-galactic-radiation';

/** Render the topbar sun widget. Click-handler opens the full SWPC page.
 *
 *  Renders as a small thumbnail of the latest HMI continuum image. If the
 *  image fails to load (network error, SWPC down), the widget hides itself.
 */
export function initSunWidget(el: HTMLElement): void {
  el.hidden = true;
  el.textContent = '';
  el.classList.add('sun-badge');
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', 'Sun image (sunspots)');
  el.title = 'Latest sun (SDO HMI continuum) — click for SWPC dashboard';

  const img = document.createElement('img');
  img.className = 'sun-thumb';
  img.alt = 'Sun image with sunspots (SDO HMI)';
  // Append a cache-buster query so the browser revalidates roughly hourly
  // (sun imagery updates ~every 15min upstream; once per hour is plenty).
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  img.src = `${SWPC_SUN_IMAGE_URL}?h=${hourBucket}`;

  img.onload = () => {
    el.hidden = false;
  };
  img.onerror = () => {
    // SWPC down, network issue, or geofence — silently hide the widget.
    el.hidden = true;
  };

  el.replaceChildren(img);

  const open = () => {
    window.open(SWPC_SUN_DASHBOARD_URL, '_blank', 'noopener,noreferrer');
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
}
