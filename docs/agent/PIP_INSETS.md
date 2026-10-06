# Picture-in-picture insets

The map inset and the horizon inset are previews. A tap on one opens the view it shows. Phones do not get them, and the phone layout does not change.

## Gate

Show an inset when the viewport is at least 800px wide and 600px tall. The check is `matchMedia('(min-width: 800px) and (min-height: 600px)')` plus the same test on `innerWidth` and `innerHeight` before any inset map is created. `INSET_MIN_WIDTH_PX` and `INSET_MIN_HEIGHT_PX` in `frontend/src/insets/gate.ts` are that pair, and the host builds its media query from them. It is not a user-agent test.

The height floor is 600 because the check reads the usable viewport. iPad Pro 11 landscape in a Safari tab is about 1194×710. A 1280×800 laptop window is about 1280×700. An 800px height floor hides the insets on both, and Anil uses Safari tabs. iPhone landscape stays under about 440px tall, including 874×402, 844×390, and 932×430, so those stay out. Width stays 800. A portrait phone is narrower than that, and iPad Pro 11 portrait is 834 wide, so it stays in. Width alone is still the wrong test. iPhone 17 Pro landscape is 874px wide, and iPad Pro 11 portrait is 834px wide.

## Where they sit

Both insets are at least a 44px hit target, and `position: absolute` so they do not reflow the phone layout. On a phone the buttons stay `hidden` and the ISS scene keeps today's padding. The plan inset stays 148×96. The horizon inset is 222×144 on a viewport the gate accepts.

### Map view, the horizon inset

The resting place is the same on iPad Pro 11 portrait (834×1194), iPad Pro 11 landscape (1194×834 and a Safari tab at 1194×710), and desktop (1280×800, and a laptop window at 1280×700). It is the bottom-right corner of the map pane, above Hide. The top left stays the Show toolbar and `.maplibregl-ctrl-top-left` (the MapLibre zoom and compass). The dock still occupies the top right, and its `max-height` stops 12px above the inset. The legend stays on the bottom left. On a fitting viewport its max-width stops at `--horizon-span`, 246px from the right. Below 720px tall with the shoot list open, that same span replaces the short-landscape legend cap so the legend does not reach the inset.

Hide stays 88×44 at `right: 12px`. It does not move between Controls and Hide. The inset's right edge is the same 12px. Its bottom is `--horizon-bottom`, which is `--map-command-bottom` (0 on a fitting viewport) plus the strip height plus 36px. With the controls open the strip is 96px plus the home indicator, so the inset sits 36px above the strip and clear of Hide. A signed-out banner with actions lifts Hide to `7.75rem`, and `--horizon-bottom` becomes that offset plus 44px plus 12px so the inset stays above the lifted button.

The strip's right edge is `--horizon-span`. Its padding-right is 8px, because Hide is outside the strip. The slider row is at least 8rem and the slider itself is 32px tall. The skip buttons stay 44px so they still share Hide's vertical center. Below 520px the short-landscape rules still own the 52px row, `--map-command-bottom`, and `bottom: calc(var(--map-command-bottom) + var(--map-command-height) + 36px)`. That query cannot match the gate, so those rules do not move the visible inset.

The inset hides while the pin inspector is open, while the satellite picker is open, and while map chrome is hidden (`#map-pane.map-chrome-hidden`). With the controls closed the time strip is gone, and the same corner would sit on the Controls button. It returns when they open again. Activating the button focuses `#tab-iss` before the view changes, so Enter and Space do not leave focus on `body`.

### ISS view, the plan inset

The resting place is the bottom left of the ISS pane, 12px from the left and 12px from the bottom. iPad portrait has a tall empty band under the Telemetry row. iPad landscape and desktop do not, so when the gate matches, the scene gains `padding-bottom: 7.75rem` and the earth frame shrinks into the space above that band. The inset sits in the band.

That band is below the Telemetry button, the Launch menu, and the launch card. The card sits beside the earth on these widths. Port and Starboard stay beside the frame. The clock, the edition line, the field readout, and the hint stay on the toolbar or on the frame. The help button is the bottom right of the viewport. The inset is the bottom left of the pane.

Fullscreen removes the extra padding and hides the inset. The earth frame grows back to the fullscreen fit. Leaving fullscreen restores the band and the inset.

## What each inset must miss

A visible box counts. A `hidden` control or a `display: none` control does not.

On the map, the inset misses the top bar, the status line, the Show label and All, Mine, and Launches, `.maplibregl-ctrl-top-left`, the Bearing and Layers labels and their buttons, the time strip, the slider, Now and +36h, the readout, T-90, T-45, Now, T+45, and T+90, Hide, `#map-legend-toggle`, `#map-legend-panel`, the legend items, and the imagery note. The drive overlap list names `.maplibregl-ctrl-top-left`, `#map-legend-toggle`, and `#map-legend-panel` as their own selectors. `elementFromPoint` at each of those legend centers is not the inset.

On the ISS view, the inset misses the top bar, the status line, the help button, Keyboard shortcuts, Full screen, Horizon, Straight down, the Cupola select, the five clock lines, the edition line, Port, Starboard, the field readout, the hint, the launch card, Telemetry, the Launch menu, the attribution button, and any place name on the earth.

## Rendering

The horizon inset calls `createIssRenderer` with `labels: false`, so it does not fetch the place-name catalog and does not lay out labels. That function keeps one module-level hook slot, so the inset exists only while the full ISS scene is disposed. Opening ISS view destroys the horizon inset first, then mounts the scene. The plan inset is a second mercator map, `createTrackInset`, drawing `groundTrackFeatures` and `markerPositionAt` from the existing track code. It can sit beside the full horizon scene.

Neither inset map is created when the gate fails, when its tab is not showing, when the document is hidden, or when ISS fullscreen is active. Updates are 1s for the ISS dot and the horizon aim, and 5s for the ground-track line. Leaving the tab or hiding the document destroys that inset map.
