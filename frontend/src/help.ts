/** In-page help panel (the ⟨?⟩ corner button).
 *
 *  A fixed bottom-right "?" button opens a modal that explains the app's
 *  features for a new astronaut — the five tabs, how to read a pass card,
 *  the map overlays, and the photo-lookup tool. Content is plain data
 *  rendered with textContent (no operator input, but textContent keeps it
 *  XSS-safe by construction and matches the rest of the modal code).
 *
 *  Reuses the existing .modal-backdrop / .modal styling (see style.css
 *  "Rating modal"); adds .help-modal for the wider, scrollable layout.
 *
 *  Close on: ✕ button, backdrop click, or Escape. Matches openTokenModal()
 *  conventions in main.ts.
 */

interface HelpItem {
  /** Leading glyph (emoji or symbol) shown before the label. '' for none. */
  icon: string;
  /** Bold lead-in, e.g. a tab name or control. */
  label: string;
  /** The explanation. */
  text: string;
}

interface HelpSection {
  title: string;
  items: HelpItem[];
}

/** The help content. Kept in one place so it's easy to keep in sync with
 *  the UI as features land. */
const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'What this is',
    items: [
      {
        icon: '🛰️',
        label: 'Orbit Photo Director',
        text:
          'A shot planner for Earth photography from the ISS. It tells you ' +
          'what your camera targets are about to pass under, when, and ' +
          'whether the light and clouds make the shot worth taking.',
      },
    ],
  },
  {
    title: 'The five tabs',
    items: [
      {
        icon: '',
        label: 'Queue',
        text:
          'Next 90 minutes — what to shoot now. Cards are sorted by time ' +
          'or score. This is your "raise the camera" list.',
      },
      {
        icon: '',
        label: 'Upcoming',
        text:
          'Next 36 hours — what to plan for. Same scoring as Queue but on ' +
          'forecast cloud, so it is less certain by design.',
      },
      {
        icon: '',
        label: 'Map',
        text:
          'Live ISS position and ground track, your targets, and overlays ' +
          '(clouds, day/night, night-lights, labels, rocket ascent paths).',
      },
      {
        icon: '',
        label: 'Profile',
        text:
          'Your targets and settings. Add or hide targets, set how far ' +
          "off-nadir you'll accept, and use the photo-lookup tool.",
      },
      {
        icon: '',
        label: 'Log',
        text:
          'Your shoot/skip history. Rating shots here helps tune which ' +
          'passes get surfaced for you.',
      },
    ],
  },
  {
    title: 'Reading a pass card',
    items: [
      {
        icon: '⏱️',
        label: 'Countdown',
        text: 'Time until the ISS is at closest approach to that target.',
      },
      {
        icon: '⭐',
        label: 'Score',
        text:
          'p(clear sky) × lighting fit × how close to straight-down × your ' +
          'priority. Tap the score to see the breakdown.',
      },
      {
        icon: '🌍',
        label: 'Zoom preview',
        text:
          'Tap the globe to expand a satellite thumbnail of the target with ' +
          'the ISS track drawn over it, so you know what to look for.',
      },
      {
        icon: '📐',
        label: 'Nadir distance',
        text:
          'How far the target sits from the point directly below the ISS. ' +
          'Smaller is a more straight-down, less oblique shot.',
      },
      {
        icon: '🧭',
        label: 'Look angle & window',
        text:
          'The direction tag reads like the CEO target sheets: "26° right of ' +
          'track" means aim the camera 26° off straight-down, to the right of ' +
          'your ground path (at closest approach the target is abeam, so that ' +
          'one number is both the tilt and how far off-track it is). Under ~30° ' +
          'off-nadir you can shoot from the WORF (Destiny nadir window); beyond ' +
          'that it is a Cupola shot.',
      },
    ],
  },
  {
    title: 'Pass card buttons',
    items: [
      {
        icon: '📸',
        label: 'Shoot',
        text:
          'Log that you took the shot. Your shoot/skip history tunes which ' +
          'passes get surfaced for you.',
      },
      {
        icon: '⏭️',
        label: 'Skip',
        text: 'Log that you passed on it — also feeds the tuning, the other way.',
      },
      {
        icon: '🔔',
        label: 'Remind',
        text:
          'Add this pass to your shot list for a calendar reminder (see ' +
          'Calendar reminders below). Tap again to remove it.',
      },
      {
        icon: '🙈',
        label: 'Hide',
        text:
          'Remove a target from your view. Curated (shared) targets are ' +
          'restorable from the Profile tab; your own personal targets are ' +
          'deleted, so re-add them in Profile if you change your mind.',
      },
      {
        icon: '🔑',
        label: 'Calibration token',
        text:
          'Shoot/Skip work offline and queue locally; they upload to the ' +
          'server once you paste your calibration token in the Log tab. Until ' +
          'then the buttons read "set token" and the pending count waits.',
      },
    ],
  },
  {
    title: 'Calendar reminders (🔔)',
    items: [
      {
        icon: '🔔',
        label: 'Build a shot list',
        text:
          'Tap 🔔 Remind on any Queue or Upcoming pass to add it to a shot ' +
          'list for the day. A bar appears at the bottom: "N selected — Add ' +
          'to Calendar."',
      },
      {
        icon: '📅',
        label: 'Add to Calendar',
        text:
          'Tap Add to Calendar and your phone opens an "Add All to Calendar" ' +
          'sheet. Each pass becomes an event with two alarms: 5 minutes before, ' +
          'and at closest approach. They fire even with the app closed and the ' +
          'phone locked, because the OS calendar handles them — not the app. ' +
          'The reminders are only live once you tap Add in Calendar.',
      },
    ],
  },
  {
    title: 'Sorting & filtering',
    items: [
      {
        icon: '🔀',
        label: 'Time / Score',
        text:
          'Order cards chronologically (what is next on the timeline) or by ' +
          'score (best opportunity first).',
      },
      {
        icon: '👥',
        label: 'All / Mine',
        text: 'Show every shared target, or just the ones in your profile.',
      },
    ],
  },
  {
    title: 'Map overlays (right-edge buttons)',
    items: [
      { icon: '☁️', label: 'Clouds', text: 'Live/forecast cloud cover.' },
      { icon: '☀️', label: 'Terminator', text: 'The day/night line and the sub-solar point.' },
      { icon: '🌃', label: 'Night-lights', text: 'City lights on the night side (off by default).' },
      { icon: '🏷️', label: 'Labels', text: 'Country and city names.' },
      { icon: '↻', label: 'Multi-orbit', text: 'The next several ISS orbits, not just the current one.' },
      { icon: '🚀', label: 'Ascent', text: 'Rocket climb paths for active launches you could catch.' },
      { icon: '🛰️', label: 'Satellites', text: 'Track other craft — Tiangong, Hubble, Starship, and more.' },
      { icon: '📍', label: 'Follow ISS', text: 'Recenter on the station; pan away to release.' },
      { icon: 'N↑ / ISS↑', label: 'Bearing', text: 'North up, or rotate so the ISS direction of travel points up.' },
    ],
  },
  {
    title: 'Drop a pin on the map',
    items: [
      {
        icon: '📌',
        label: 'When is the ISS over here?',
        text:
          'Long-press anywhere on the map (or right-click on desktop) to drop ' +
          'a pin. You get the next few passes over that exact spot in the ' +
          'coming 36 hours, each with its time, off-nadir angle, and which ' +
          'window to shoot from.',
      },
    ],
  },
  {
    title: 'Working offline',
    items: [
      {
        icon: '✈️',
        label: 'What still works',
        text:
          'The app and your last-synced passes load with no connection. The ' +
          'banner shows how long since the last sync ("LOS · 3h ago") and ' +
          'flags stale data, because pass times drift as the clock advances.',
      },
      {
        icon: '🗺️',
        label: 'Map tiles are cached, not complete',
        text:
          'Offline, the map only has the imagery you already loaded online, ' +
          'plus a world view. Zoom into a spot or pan to an area you did not ' +
          'view online and the basemap can go black there. Cloud and ' +
          'night-light layers only have tiles for places you viewed with that ' +
          'layer turned ON while online — so toggling a layer on offline over ' +
          'a fresh area may show nothing. That is the cache, not a fault: load ' +
          'the areas you care about while you still have signal.',
      },
    ],
  },
  {
    title: 'Photo lookup (Profile tab)',
    items: [
      {
        icon: '📷',
        label: 'Where was the ISS?',
        text:
          'Paste a UTC timestamp or drop a photo with EXIF, and get a map ' +
          'pin plus a .kml for Google Earth showing where the station was.',
      },
    ],
  },
];

/** Build and show the help modal. Idempotent — a second call while open is
 *  a no-op so double-taps don't stack backdrops. Guards on DOM presence
 *  (not a module flag) so it can't desync if the backdrop is removed by
 *  some other path. */
export function openHelpModal(): void {
  if (document.querySelector('.help-modal')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal help-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Help — how to use Orbit Photo Director');

  const header = document.createElement('div');
  header.className = 'help-header';
  const title = document.createElement('h3');
  title.textContent = 'How to use this';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'help-close';
  close.setAttribute('aria-label', 'Close help');
  close.textContent = '✕';
  header.append(title, close);

  const body = document.createElement('div');
  body.className = 'help-body';

  for (const section of HELP_SECTIONS) {
    const h = document.createElement('h4');
    h.className = 'help-section-title';
    h.textContent = section.title;
    body.appendChild(h);

    const list = document.createElement('ul');
    list.className = 'help-list';
    for (const item of section.items) {
      const li = document.createElement('li');
      li.className = 'help-item';
      if (item.icon) {
        const ic = document.createElement('span');
        ic.className = 'help-item-icon';
        ic.textContent = item.icon;
        li.appendChild(ic);
      }
      const txt = document.createElement('span');
      txt.className = 'help-item-text';
      const strong = document.createElement('strong');
      strong.textContent = item.label + ' ';
      txt.append(strong, document.createTextNode(item.text));
      li.appendChild(txt);
      list.appendChild(li);
    }
    body.appendChild(list);
  }

  modal.append(header, body);
  backdrop.appendChild(modal);

  let closed = false;
  const dismiss = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  };

  close.addEventListener('click', dismiss);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) dismiss();
  });
  document.addEventListener('keydown', onKey);

  document.body.appendChild(backdrop);
  // Focus the close button so Escape/Enter work immediately and the
  // screen-reader announces the dialog label first.
  requestAnimationFrame(() => close.focus());
}

/** Wire the fixed "?" corner button to the help modal. Call once at boot.
 *  No-ops if the button isn't in the DOM (older test fixtures). */
export function bindHelp(): void {
  const fab = document.getElementById('help-fab');
  if (!fab) return;
  fab.addEventListener('click', openHelpModal);
}
