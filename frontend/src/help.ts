/** In-page help panel (the ⟨?⟩ corner button).
 *
 *  A fixed bottom-right "?" button opens a modal that explains the app
 *  for the astronaut using it. The tabs, legend, Cupola windows, targets,
 *  top bar, and sign-in footer are in the sections below the
 *  title. Content is plain data
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
  /** Optional stable anchor: UI elements deep-link to this entry via
   *  openHelpModal(id) (photo-condition rows → Photography Almanac). */
  id?: string;
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
        label: 'SNAP',
        text:
          'A shot planner for Earth photography from the ISS. The Map opens ' +
          'first. Queue is what to shoot in the next 90 minutes. The app ' +
          'does not take the photo.',
      },
    ],
  },
  {
    title: 'The six tabs',
    items: [
      {
        icon: '',
        label: 'Queue',
        text:
          'Next 90 minutes. Sort by Time or Score. Show All targets or only ' +
          'Mine. Cards offer Shoot, Skip, Remind, and Hide. A launch card ' +
          'can sit in front when a launch is in view. It lists the window, ' +
          'direction, and chance. A visible pad is a possible shot.',
      },
      {
        icon: '',
        label: 'Upcoming',
        text:
          'Next 36 hours, scored with forecast cloud, so it is less certain ' +
          'than Queue. Same Time, Score, All, and Mine controls. Cards have ' +
          'Remind and Hide. They do not have Shoot or Skip. A notice appears ' +
          'when orbital night goes away.',
      },
      {
        icon: '',
        label: 'Map',
        text:
          'Live ISS position, the ground track, and your targets. The time ' +
          'slider looks ahead up to 36 hours. Launches, on the map toolbar, ' +
          'draws the ascent path and the pad in gold.',
      },
      {
        icon: '',
        label: 'ISS view',
        text:
          'A modeled live view from the station. The frame is a fitted ' +
          '14 mm full-frame picture with cloud-free Blue Marble and Black ' +
          'Marble 2016. It is a spherical model, not the window and not a ' +
          'live photo.',
      },
      {
        icon: '',
        label: 'Profile',
        text:
          'Your account, how far off straight-down you will accept, your ' +
          'own targets, hidden shared targets, and photo lookup.',
      },
      {
        icon: '',
        label: 'Log',
        text:
          'Your shoot and skip history. Rate a shoot from its row. A number ' +
          'on the Log tab is how many entries are still waiting to sync.',
      },
    ],
  },
  {
    title: 'Aiming the ISS view',
    items: [
      {
        icon: '',
        label: 'Horizon',
        text:
          'Looks at the limb. This is the view when nothing is saved. ' +
          'The Horizon button and h do the same: they clear a drag and ' +
          'keep a pinched field.',
      },
      {
        icon: '',
        label: 'Straight down',
        text:
          'Looks at the ground under the station. Use the Straight down ' +
          'button, or n / N. A pinch stays.',
      },
      {
        icon: '',
        label: 'Pan',
        text:
          'Drag the picture, or use the arrow keys. W, A, S, and D pan ' +
          'the same way. Hold Shift for a smaller step.',
      },
      {
        icon: '',
        label: 'Field of view',
        text: 'Pinch or scroll the picture. + narrows the field. - widens it.',
      },
      {
        icon: '',
        label: 'Cupola',
        text:
          'Windows 1 through 6 look around the limb. Window 7 looks ' +
          'straight down. Keys 1 through 7 pick the same windows, and a ' +
          'window returns the field to the 14 mm lens.',
      },
      {
        icon: '',
        label: 'Saved aim',
        text:
          'This device remembers the aim. The page address can share it: ' +
          '#iss= holds that aim.',
      },
      {
        icon: '',
        label: 'Launch',
        text:
          'The Launch menu sits beside Telemetry. Chances for the next ' +
          'seven days come first. All launches lists every scheduled ' +
          'launch in the next 14 days that is Go, Confirmed, or TBC, ' +
          'timed to the second, minute, or hour. That list is not limited ' +
          'to chances. Map and Upcoming list chances only. Choosing one ' +
          'keeps the aim and shows that pad, its time, and whether the ' +
          'site is in the picture now. None clears it.',
      },
      {
        icon: '',
        label: 'Pad look',
        text:
          'The selected pad\'s name sits beside Telemetry. The arrow points ' +
          'at the pad. A tap looks about 18° that way.',
      },
      {
        icon: '',
        label: 'Pad marker',
        text:
          'A gold pin marks the pad in the picture. An arrow on the edge ' +
          'marks it when the pad is on the Earth but outside the picture.',
      },
      {
        icon: '',
        label: 'Ascent path',
        text:
          'The gold path appears only when that launch includes a trajectory.',
      },
    ],
  },
  {
    title: 'Reading a pass card',
    items: [
      {
        icon: '⏱️',
        label: 'Countdown',
        text:
          'Time until closest approach, the moment the station is nearest ' +
          'that target.',
      },
      {
        icon: '⭐',
        label: 'Score',
        text:
          'Tap the stars for the breakdown. The number mixes the chance of ' +
          'a clear view, the lighting fit, how close the target is to ' +
          'straight-down, your priority, and how fresh the orbit data is.',
      },
      {
        icon: '🌍',
        label: 'Zoom preview',
        text:
          'Tap the globe on a card for a satellite thumbnail and the ' +
          'nearest station weather.',
      },
      {
        icon: '📐',
        label: 'Nadir distance',
        text:
          'How far the target sits from the point directly below the ISS. ' +
          'The look tag also gives the off-nadir angle and which side, as ' +
          'in "29° right of track", plus the window. Under 30° off-nadir ' +
          'the window is WORF. Wider than that, it is Cupola.',
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
          'Log that you took the shot. The card then asks "how\'d it come ' +
          'out?" Tap a star. Shoot stays off when the published data is ' +
          'too old to trust.',
      },
      {
        icon: '⏭️',
        label: 'Skip',
        text: 'Log that you passed on it. Skip is not on Upcoming cards.',
      },
      {
        icon: '🔔',
        label: 'Remind',
        text:
          'Add this pass to the shot list for a calendar reminder. Tap ' +
          'again to remove it.',
      },
      {
        icon: '🙈',
        label: 'Hide',
        text:
          'On a shared target, Hide removes it from your view until you ' +
          'Restore it on Profile. On one of your own targets, Hide deletes ' +
          'it. Add it again on Profile if you want it back. Hide on a ' +
          'keepsake window only dismisses that card.',
      },
      {
        icon: '🔑',
        label: 'Sign-in for ratings',
        text:
          'Shoot, Skip, and ratings use your Google sign-in. Offline ' +
          'entries wait on this device and sync when you are connected and ' +
          'signed in. No extra calibration token is needed.',
      },
    ],
  },
  {
    title: 'Calendar reminders',
    items: [
      {
        icon: '📅',
        label: 'Add to Calendar',
        text:
          'Tap Remind on a Queue or Upcoming pass. A bar at the bottom ' +
          'counts the selection. Tap Add to Calendar. Each pass becomes an ' +
          'event with two alarms, 5 minutes before the pass and at closest ' +
          'approach.',
      },
    ],
  },
  {
    title: 'Cupola windows',
    items: [
      {
        icon: '📸',
        label: 'Keepsake',
        text:
          'On Queue, Keepsake lists windows for a photo of something ' +
          'floating in the Cupola, with a daylit, low-cloud Earth and a mix ' +
          'of land and ocean behind the station. A window can show a golden ' +
          'hour tag. These windows are not a row in the map legend.',
      },
    ],
  },
  {
    title: 'Map legend',
    items: [
      {
        icon: '🎨',
        label: 'Rows',
        text:
          'The legend reads launch, day, twilight, and eclipse. The ISS ' +
          'marker, Anil\'s targets, Starship, and your white rings are not ' +
          'rows. It starts closed. On a wide screen, Legend sits immediately ' +
          'left of Hide in the bottom-right corner. Tap it to open the rows ' +
          'and the imagery date. On a narrow screen, Legend stays immediately ' +
          'left of Hide, and the open list sits above the time row when that ' +
          'band can hold it. When the band cannot, the list scrolls in the ' +
          'free space above the footer, clear of the zoom column and the time ' +
          'row. Tap Legend again, or press Escape, to ' +
          'close it. That choice is not remembered. A live IR warning adds a mark ' +
          'on Legend while the list is closed.',
      },
      {
        icon: '🚀',
        label: 'Starship',
        text:
          'Starship is not a legend row. When a public orbit is available, ' +
          'the map draws a red diamond labeled Starship and a dotted track. ' +
          'The Starship checkbox under the satellite button is a separate ' +
          'search.',
      },
    ],
  },
  {
    title: 'Map controls',
    items: [
      {
        icon: '☁️',
        label: 'Clouds',
        text:
          'The clouds button shows the observed cloud picture. Scrubbing ' +
          'time does not swap it for a forecast.',
      },
      {
        icon: '🌡️',
        label: 'IR',
        text:
          'IR is off until you turn it on. It shows live cloud-top ' +
          'temperature and switches among GOES / Himawari / Meteosat to ' +
          'match the view. It misses low cloud and fog. The badge says so.',
      },
      {
        icon: '☀️',
        label: 'Right edge',
        text:
          'Also on the right edge: the day-night line, night lights (off ' +
          'until you turn them on), place labels, extra ISS orbits, and ' +
          'other satellites (Tiangong, Hubble, X-37B, or a name you add). ' +
          'ISS up is the default and points the direction of travel up. ' +
          'North up keeps north at the top. The target button recenters on ' +
          'the station. Pan away to release it.',
      },
    ],
  },
  {
    title: 'Scrub time on the map',
    items: [
      {
        icon: '🕐',
        label: 'Time slider',
        text:
          'Drag the slider, or step 45 or 90 minutes, to any moment in the ' +
          'next 36 hours. The track, the station, the day-night line, other ' +
          'satellites, and the pins follow. The backward steps stop at now. ' +
          'The view stays on the time you chose until real time catches up. ' +
          'The imagery date keeps the observed clouds and says they are ' +
          'not forecast. That line sits in the legend and shows only while ' +
          'the legend is open. A live IR warning stays marked on Legend while that ' +
          'list is closed. A stale TLE tag appears when the orbit solution is ' +
          'over 48 hours old.',
      },
    ],
  },
  {
    title: 'Pins',
    items: [
      {
        icon: '📌',
        label: 'Drop a pin',
        text:
          'Long-press the map, or right-click on desktop, to drop a pin and ' +
          'see the next passes over that spot, with time and off-nadir angle.',
      },
      {
        icon: '👆',
        label: 'Tap a target pin',
        text:
          'Tap a target dot or your white ring. The card shows the pass ' +
          'time, how far off the ground track it sits, and the cloud at the ' +
          'pass. A live cloud reading can fill in a moment later. "No ' +
          'upcoming pass in window" means there is no pass in range. When ' +
          'pins overlap, the tap picks the nearest one to your finger.',
      },
      {
        icon: '✏️',
        label: 'Edit a target',
        text:
          'Tap one of your own targets, then Edit target. Profile opens ' +
          'with that place ready to change. Curated targets have no Edit ' +
          'button. Saving pulls the server list first and changes that one ' +
          'place, so an edit from two devices does not wipe the other list.',
      },
    ],
  },
  {
    title: 'Your targets',
    items: [
      {
        icon: '⚪',
        label: 'Personal targets',
        text:
          'On Profile, add a place by name or by latitude and longitude. It ' +
          'shows as a white ring. Mine on Queue, Upcoming, and Map keeps ' +
          'only those places. New rings get a geometric pass. They do not ' +
          'get a cloud forecast.',
      },
    ],
  },
  {
    title: 'Top bar',
    items: [
      {
        icon: '🛰️',
        label: 'ISS readout',
        text:
          'The top bar shows ISS, then latitude, longitude, and the region ' +
          'below the station, as in "12.3°N, 45.6°E over Africa". If the ' +
          'position cannot be computed, it says "live track expired". When ' +
          'the feeds load, a Kp badge and a sun thumbnail appear beside it. ' +
          'Your name opens Profile. Tracked satellites you turn on can ' +
          'appear after a vertical bar.',
      },
    ],
  },
  {
    title: 'Sign in and reload',
    items: [
      {
        icon: '🔐',
        label: 'Session expired',
        text:
          'If the session is missing when the app starts, the footer says ' +
          'to sign in again. Sign in and Reload are in that footer. Each ' +
          'one opens the sign-in page. Ratings already saved on this device ' +
          'stay here.',
      },
      {
        icon: '🧹',
        label: 'Stuck on an old version',
        text:
          'If the site looks stuck on an old version, or buttons do not ' +
          'respond in Safari, clear this site\'s data. On iPhone or iPad, ' +
          'open Settings > Apps > Safari > Advanced > Website Data, remove ' +
          'astroanil, and reopen the site.',
      },
    ],
  },
  {
    title: 'Working offline',
    items: [
      {
        icon: '✈️',
        label: 'Last sync',
        text:
          'With no connection the app still opens the last queue it saved. ' +
          'The footer says LOS and how old that copy is.',
      },
      {
        icon: '🗺️',
        label: 'Map tiles',
        text:
          'Offline, the map only has imagery you already loaded, plus a ' +
          'world view. Pan or zoom somewhere new and the basemap can go ' +
          'black there. That is the cache. Load the areas you care about ' +
          'while you still have a signal.',
      },
    ],
  },
  {
    title: 'Photo lookup',
    items: [
      {
        icon: '📷',
        label: 'Where was the ISS?',
        text:
          'On Profile, paste a UTC time or drop a photo with EXIF. The map ' +
          'drops a pin where the station was.',
      },
    ],
  },
  {
    title: 'Photography Almanac',
    items: [
      {
        icon: '📖',
        label: 'Using this almanac',
        id: 'almanac-intro',
        text:
          'This is the photographer\'s field guide for the station — the camera ' +
          'recipes and the physics behind each subject, grounded in Don Pettit\'s ' +
          'Astronauts\' Guide to Photography from Space. The condition rows on an ' +
          'expanded pass each deep-link down here: tap a sprite-watch, a moonlit ' +
          'sky, or a glint setup and you land on the matching card with Pettit\'s ' +
          'verbatim settings. Five subjects get a live per-pass row when the ' +
          'geometry is right — sprites, noctilucent clouds, golden hour, sun glint, ' +
          'and the Moon (the beta-blackout notice and the camera line ride along ' +
          'too). Aurora has its own topbar cue instead: the Kp badge and the ' +
          'aurora-visibility note, not a pass row. The last three carry no ' +
          'condition row and live here as pure reference: for the faint pair — ' +
          'stars and the Milky Way, and meteor showers — the live cue is the moon ' +
          'row going quiet (a dark sky); cities at night are Moon-tolerant and have ' +
          'the Night-lights map overlay to place them. Source: Pettit, Astronauts\' ' +
          'Guide to Photography from Space, 2nd ed. 2017 — topical guide cards.',
      },
      {
        icon: '📷',
        label: 'Shutter floors & the camera line',
        id: 'almanac-camera',
        text:
          'The expanded pass panel shows, per lens (400/800/1200mm — the ' +
          'long-lens kit that flies), the ground footprint at THIS pass\'s ' +
          'closest approach and the slowest safe shutter speed. The floors ' +
          'assume HAND-TRACKING: the ground moves ~7.7 km/s, and as Don ' +
          'Pettit\'s guide puts it, "even the fastest shutter speeds will ' +
          'not stop the blurring effects of orbital motion" — you track the ' +
          'target through the viewfinder and the floor handles handshake. ' +
          'His D5-era rule was 1/(focal length); current Z9 bodies have ' +
          'finer pixels, so these floors run ~1.5× faster (400mm ≥1/640 · ' +
          '800mm ≥1/1250 · 1200mm ≥1/2000). NOT tracking? You need about a ' +
          'stop faster still (400mm ~1/1250 at nadir) and it worsens near ' +
          'nadir. Expect ~10 seconds of prime nadir viewing per pass. ' +
          'Telephoto >85mm needs Russian-segment windows or the Cupola ' +
          'bump-shield panes — scratch panes ruin long-lens work. Daytime ' +
          'starting point: ISO 200–400, f5.6–8, sunny-16 minus ~2 stops so ' +
          'cloud tops don\'t blow out. (Source: Pettit, Astronauts\' Guide ' +
          'to Photography from Space, 2nd ed. 2017 — Fig. 23, Telephoto ' +
          'Lens Skills, Sunny 16.)',
      },
      {
        icon: '⚡',
        label: 'Sprites — upward lightning at the limb',
        id: 'almanac-sprites',
        text:
          'Sprites are brief red flashes of upward lightning into the '
          + 'mesosphere (about 50–90 km) above strong storms. The catch: '
          + '"you will not be able to see them with your eyes" (Pettit) — '
          + 'you shoot the dark limb above a distant vigorous storm on '
          + 'faith. So a heads-up that such a storm is in view at the limb '
          + 'is the whole game. The sprite-watch row fires on a night pass '
          + 'when a strong electrically-active storm sits in the limb '
          + 'annulus (600–3200 km out) and the sky is dark — possible '
          + 'sprites, not a detection. Mount on the Bogen arm and aim toward '
          + 'the flagged storm, at the limb or near nadir as the geometry '
          + 'allows; long-ish exposures catch multiple flashes. His '
          + 'settings: f2.8, start ISO 1600 / 2s, then trade down the ladder '
          + '(4s/800 · 2s/1600 · 1s/3200 · 1/2s/6400 · 1/4s/12800); LiveView '
          + '10× to focus. Coverage is the Americas and Atlantic only '
          + '(GOES lightning mapper). Source: Pettit, Astronauts\' Guide to '
          + 'Photography from Space, 2nd ed. 2017 — Lightning and Sprites.',
      },
      {
        icon: '✨',
        label: 'Sun glint — light off the water',
        id: 'almanac-glint',
        text:
          'Sun glint is the Sun reflecting specularly off water straight '
          + 'into your camera — a bright spot that reveals surface detail '
          + 'invisible under flat light: ocean eddies and free vortices you '
          + 'can track for months, ship wakes like contrails, internal '
          + 'waves, river channels, estuary mixing. Pettit calls it some of '
          + 'the most fascinating water imagery from orbit. It happens near '
          + 'local noon when the geometry lines up — the app predicts that '
          + 'geometry on the curated coastal targets (archipelagos, straits, '
          + 'canals, big lakes); whether the glint actually shows depends on '
          + 'the sea state, which the geometry cannot see. His settings: '
          + '180–400mm, ISO 200, 1/200–1/1000, f11–f16, matrix metering '
          + 'with about a stop of compensation, and bracket to hold the '
          + 'glint detail. (Glint is a wide-to-mid telephoto subject; for '
          + 'the long-lens motion floor see the camera line.) Source: '
          + 'Pettit, Astronauts\' Guide to Photography from Space, 2nd ed. '
          + '2017 — Sun Glint.',
      },
      {
        icon: '🌌',
        label: 'Noctilucent clouds (the highest clouds)',
        id: 'almanac-nlc',
        text:
          'Noctilucent ("night-shining") clouds are the highest clouds on '
          + 'Earth — electric-blue ice at about 83 km, in the mesosphere. '
          + 'They form only over the SUMMER pole at high latitude, and you '
          + 'see them in a narrow twilight window: the Sun has set for the '
          + 'ground below but still lights the ice deck far above, so it '
          + 'glows against a dark lower sky. From the station, look toward '
          + 'the summer pole at the limb near orbital sunrise/sunset. The '
          + 'window row fires on summer high-latitude passes when the Sun '
          + 'sits roughly 6–16° below the horizon at the viewed point — '
          + 'possible geometry, not a guarantee (NLC do not appear every '
          + 'night even in season). Pettit\'s setup: these are not '
          + 'low-light-limited, so shoot f8, ISO 400, 1/30–1/250 by '
          + 'brightness; focus on the horizon; take BOTH wide and telephoto '
          + 'frames and bracket to hold the clouds and the atmosphere '
          + 'together. (Wide-field NLC settings — for long lenses see the '
          + 'camera line\'s motion floor.) Source: Pettit, Astronauts\' '
          + 'Guide to Photography from Space, 2nd ed. 2017 — Noctilucent '
          + 'Clouds card.',
      },
      {
        icon: '🌅',
        label: 'Golden hour — low-sun terrain texture',
        id: 'almanac-golden-hour',
        text:
          'Terrain photographs best in low-angle light. When the Sun sits '
          + 'low over the target, ridges, dunes, volcanoes, and mountains '
          + 'throw long shadows that carve out relief and texture the eye '
          + 'would miss at noon. Don Pettit makes the point with two of his '
          + 'best telephoto frames: Patagonian glaciers where "the high '
          + 'contrast shadows imparted by low angle sunlight" reveal fine '
          + 'crevasse detail, and Manhattan "under low angle lighting" '
          + 'showing shadow-borne texture in the streets and projected onto '
          + 'the rivers — the opposite of the shadowless noon view a mapping '
          + 'satellite takes. So the expanded pass panel shows a golden-hour '
          + 'row on terrain targets (big-terrain, volcanoes) when the Sun is '
          + 'roughly 2–25° up at closest approach. It is advisory — it tells '
          + 'you the light is right; it does not reshuffle the Queue. His '
          + 'frames were 800mm at ISO 200, f5.6 (he shot 1/1000 on the older '
          + 'D5 body; see the camera line for your own body\'s shutter '
          + 'floor). Source: Pettit, Astronauts\' Guide to Photography from '
          + 'Space, 2nd ed. 2017 — Figs. 1 (Patagonia, Manhattan).',
      },
      {
        icon: '🟢',
        label: 'Aurora — the night-sky marquee',
        id: 'almanac-aurora',
        text:
          'Aurora is the night subject the app watches from the topbar. The ' +
          'green Kp badge on the topbar is the headline geomagnetic number, ' +
          'straight from NOAA SWPC — quiet, active, storm, or severe by color (Kp ' +
          'under 3 green, 3–5 yellow, 5–7 orange, 7–9 red), with the reading\'s age ' +
          'in the hover tooltip and a click-through to the SWPC oval map; it hides ' +
          'itself silently on any fetch failure. But Kp only says how stirred-up ' +
          'the magnetosphere is, not whether the oval is anywhere near the station. ' +
          'So a geometry-driven note rides beside the badge: it scans the live ' +
          'OVATION oval against the station\'s own horizon and appends "· aurora in ' +
          'view" when the probability over a dark, in-view patch of ground is high, ' +
          'or "· aurora nearby" when it is only suggestive — a hint that the light ' +
          'is there to chase, not a detection. The note stays quiet when the oval ' +
          'is out of view and when the nadir is daylit, so it also goes silent ' +
          'through a beta blackout (no orbital night, no aurora — the silence is ' +
          'correct, not broken; see beta angle). And it honors the Moon: when a ' +
          'bright Moon is up over the station the note hedges to "(moonlit — ' +
          'faint)," because moonlight washes faint aurora exactly as it drowns ' +
          'stars — the moon row\'s "no Moonlight night passes" rule applies here ' +
          'too. It only warns; it never suppresses the note. As a subject, aurora ' +
          'is fast and low-light: shoot a fast prime at f1.4, ISO 3200, 1/2s, or ' +
          'wide at f2.8, ISO 12800, 1/2s (1/15–1/30 is marked not-recommended); a ' +
          '14–24 or fisheye takes in the whole arc but needs about 4× the exposure. ' +
          'Keep ISO at or under 12800, focus with LiveView at 10×, steady on the ' +
          'Bogen arm, and shoot dark frames after the series for post-flight ' +
          'cosmic-ray subtraction. Source: Pettit, Astronauts\' Guide to ' +
          'Photography from Space, 2nd ed. 2017 — Aurora card.',
      },
      {
        icon: '🌠',
        label: 'Stars, Milky Way & airglow',
        id: 'almanac-night-sky',
        text:
          'On a dark night pass the sky itself is the subject. Stars and the Milky ' +
          'Way arc above the limb, and just below them sits airglow — a faint ' +
          'green-and-red band from oxygen and sodium high in the atmosphere, the ' +
          'same layer that paints the thin glowing line hugging the limb. Pettit\'s ' +
          'rule for all of it is the one the moon row already enforces: shoot ' +
          '"during no Moonlight night passes," because a bright Moon up in the sky ' +
          'drowns faint star fields and washes the airglow flat. So there is no ' +
          'dedicated star or airglow row — this is reference knowledge for a dark ' +
          'night pass, and your cue is the moon row going quiet: a dark sky shows ' +
          'no row at all, and that silence is your star-and-airglow window (the ' +
          'same window the aurora note hedges to "(moonlit — faint)" when a bright ' +
          'Moon is up). When the window is open, the Night Phenomena setup is a ' +
          'shutter-and-ISO tradeoff against your lens: at f1.4, start ISO 6400, ' +
          '1/2s; at f2.8, start ISO 12800, 1s. Keep ISO at 12800 or below — past ' +
          'that the noise costs more than it buys. Focus with LiveView at 10× on a ' +
          'bright star, mount on the Bogen arm, shoot dark frames after every ' +
          'series for ground cosmic-ray subtraction, and shroud the window so cabin ' +
          'light doesn\'t reflect in. (These are the wide-field night settings; for ' +
          'the long-lens motion floor see the camera line.) Source: Pettit, ' +
          'Astronauts\' Guide to Photography from Space, 2nd ed. 2017 — Night ' +
          'Phenomena card.',
      },
      {
        icon: '🌃',
        label: 'Cities at night — lights from the dark side',
        id: 'almanac-cities-night',
        text:
          'Cities at night are a signature night-pass subject — street grids, ' +
          'harbor fronts, and the warm-vs-white split of old sodium against new LED ' +
          'lighting, all from the dark side of the orbit. The Night-lights map ' +
          'overlay shows you WHERE the lights are so you can line a city up before ' +
          'it slides under you, but there is no city-specific condition row and no ' +
          'per-pass prompt: a city is reference knowledge for any dark pass, not a ' +
          'predicted event the way aurora or sprites are. The real enemy is motion ' +
          'blur — the ground runs under you at ~7.7 km/s and the frame is dim — so ' +
          'Pettit\'s fix is a LOOSE Bogen arm: hand-track the city across the ' +
          'window for stability rather than locking down. His settings are ' +
          'bright-glass, fast-shutter: on a medium low-light prime (50mm f1.4, 58mm ' +
          'f1.2, 85mm f1.4) start ISO 6400 at 1/60s; on the telephoto (180/400mm ' +
          'f2.8, ~4× more exposure) use ISO 12800 at 1/30s. Keep ISO at 12800 or ' +
          'below; his shutter speeds (1/60s, 1/30s) are about as fast as the dim ' +
          'scene allows — going faster just underexposes, so a night city is ' +
          'exposure-limited, not motion-floor-limited the way a daylit target is. ' +
          'That is exactly why the loose Bogen hand-track matters: it buys ' +
          'stability at a slow shutter instead of a faster one you cannot afford. ' +
          'LiveView 10× to focus, dark frames after a series, and ' +
          'control window reflections. Unlike faint stars, a bright Moon up ' +
          'doesn\'t hurt a city — the light only drowns the faint stuff — but the ' +
          'same no-orbital-night blackout that mutes aurora mutes city passes too ' +
          '(see beta angle). Source: Pettit, Astronauts\' Guide to Photography from ' +
          'Space, 2nd ed. 2017 — Cities at Night card.',
      },
      {
        icon: '☄️',
        label: 'Meteor showers — looking down on the streaks',
        id: 'almanac-meteors',
        text:
          'During a meteor shower the streaks burn up at roughly 80–120 km, which ' +
          'is BELOW you — so from the station you look DOWN at the flashes against ' +
          'the night Earth, not up at them the way the ground does. They are brief ' +
          'and unpredictable, so this is a faith shoot: lock the camera down, run ' +
          'it across the whole dark pass, and hope a streak crosses the frame. Like ' +
          'stars, the Milky Way, and cities at night, this is reference knowledge — ' +
          'there is no dedicated meteor row and the app does not predict shower ' +
          'peaks; lean on the same dark-sky window the other night subjects need. ' +
          'Pettit\'s rule for faint night sky is blunt — best "during no Moonlight ' +
          'night passes" — so let the moon row be your gate: a dark sky shows no ' +
          'row at all, and that silence is the window for streaks too (a bright ' +
          'Moon up will wash them just as it washes aurora and star fields). His ' +
          'setup: these are not low-light-limited, so shoot f5.6 — start ISO 800 at ' +
          '15s, then trade down the ladder (15s/800 · 8s/1600 · 4s/3200) if the ' +
          'Moon-dark sky still glows. Run an intervalometer so the camera fires ' +
          'repeated exposures across the pass while you work; LiveView 10× to ' +
          'focus, mount on the Bogen arm, and shroud the window to kill ' +
          'reflections. Source: Pettit, Astronauts\' Guide to Photography from ' +
          'Space, 2nd ed. 2017 — Meteor Showers card.',
      },
      {
        icon: '🌙',
        label: 'The Moon & night photography',
        id: 'almanac-moon',
        text:
          'On a night pass the Moon is the biggest variable. A bright Moon '
          + 'up in the sky floods the night-side Earth with light — '
          + 'beautiful for cloud, ocean, and terrain TEXTURE, but it '
          + 'drowns faint aurora and star fields. Don Pettit\'s rule is '
          + 'blunt: shoot stars and the Milky Way "during no Moonlight '
          + 'night passes." So the expanded-pass moon row tells you the '
          + 'phase and whether the Moon is up and washing the sky '
          + '(moonlit) or merely up and faint — and a dark sky shows no '
          + 'row at all, because that silence IS the aurora/star window. '
          + 'The aurora note hedges to "(moonlit — faint)" when a bright '
          + 'Moon is up. As a TARGET the Moon is easy: his card says start '
          + 'from Sunny 16, then f8, ISO 400, 1/1600 for the lunar disk — '
          + 'and expose for EITHER the Moon OR the night Earth, never both '
          + 'in one frame; bracket in a rapid sequence for HDR. Past 85mm '
          + 'use the Russian windows or a Cupola bump-shield pane. '
          + 'At the limb: a low Moon setting or rising through the '
          + 'atmosphere at orbital sunrise/sunset refracts into a flattened, '
          + 'distorted disk — a striking time-lapse when you catch it. '
          + '(Phase/altitude are computed from the orbit clock on your '
          + 'iPad, accurate to a planning grade for the station\'s own sky. '
          + 'Source: Pettit, Astronauts\' Guide to Photography from Space, '
          + '2nd ed. 2017 — Moon & Night Phenomena cards.)',
      },
      {
        icon: '☀️',
        label: 'Beta angle & night blackouts',
        id: 'almanac-beta',
        text:
          'The beta angle (β) is the tilt between the station\'s orbit '
          + 'plane and the sun. It cycles over ~2 months, and when |β| '
          + 'passes ~70° the station stops entering Earth\'s shadow at '
          + 'all — days with NO orbital night. Aurora, cities at night, '
          + 'star fields, and sprites are physically unavailable then (the '
          + 'aurora note staying quiet during those days is correct, not '
          + 'broken). The Upcoming tab shows a notice when a blackout is '
          + 'underway or starting within a week, computed from the same '
          + 'orbit data as everything else. The flip side is a gift: those '
          + 'days the station rides near the terminator in continuous '
          + 'low-angle sunlight — long-shadow texture passes and '
          + 'sun-never-sets time-lapses (the guide: "during some orbital '
          + 'phases, the sun never sinks below the horizon").',
      },
    ],
  },
];

/** Build and show the help modal. Idempotent — a second call while open is
 *  a no-op so double-taps don't stack backdrops. Guards on DOM presence
 *  (not a module flag) so it can't desync if the backdrop is removed by
 *  some other path. */
export function openHelpModal(anchor?: string): void {
  const existing = document.querySelector('.help-modal');
  if (existing) {
    // Already open (double-tap, or a condition row tapped while browsing):
    // don't stack a second backdrop — just bring the requested entry into
    // view in the open modal.
    if (anchor) scrollHelpToAnchor(existing as HTMLElement, anchor);
    return;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'modal help-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Help — how to use SNAP');

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
      if (item.id) li.id = `help-${item.id}`;
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
  if (anchor) scrollHelpToAnchor(modal, anchor);
  // Focus the close button so Escape/Enter work immediately and the
  // screen-reader announces the dialog label first.
  requestAnimationFrame(() => close.focus());
}

/** Scroll the help body so the anchored entry tops the viewport. Missing
 *  anchor → no scroll (the modal simply opens at the top — graceful). */
function scrollHelpToAnchor(modal: HTMLElement, anchor: string): void {
  const target = modal.querySelector<HTMLElement>(`#help-${anchor}`);
  if (!target) return;
  // scrollIntoView on the li keeps the math simple regardless of which
  // ancestor scrolls (.help-body owns overflow in CSS).
  target.scrollIntoView({ block: 'start' });
}

/** The map page has no corner ?. Queue, Upcoming, ISS view, Profile, and Log keep it. */
export function syncHelpButton(): void {
  const fab = document.getElementById('help-fab');
  if (!(fab instanceof HTMLButtonElement)) return;
  fab.hidden = document.getElementById('view')?.classList.contains('view-map') === true;
}

/** Wire the fixed "?" corner button to the help modal. Call once at boot.
 *  No-ops if the button isn't in the DOM (older test fixtures). */
export function bindHelp(): void {
  const fab = document.getElementById('help-fab');
  if (!fab) return;
  syncHelpButton();
  fab.addEventListener('click', () => openHelpModal());
}
