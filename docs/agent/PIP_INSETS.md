# Picture-in-picture insets

The map inset and the horizon inset are previews. A tap on one opens the view it shows. Phones do not get them, and the phone layout does not change.

## Gate

Show an inset when the viewport is at least 800px wide and 600px tall. The check is `matchMedia('(min-width: 800px) and (min-height: 600px)')` plus the same test on `innerWidth` and `innerHeight` before any inset map is created. `INSET_MIN_WIDTH_PX` and `INSET_MIN_HEIGHT_PX` in `frontend/src/insets/gate.ts` are that pair, and the host builds its media query from them. It is not a user-agent test.

The height floor is 600 because the check reads the usable viewport. iPad Pro 11 landscape in a Safari tab is about 1194×710. A 1280×800 laptop window is about 1280×700. An 800px height floor hides the insets on both, and Anil uses Safari tabs. iPhone landscape stays under about 440px tall, including 874×402, 844×390, and 932×430, so those stay out. Width stays 800. A portrait phone is narrower than that, and iPad Pro 11 portrait is 834 wide, so it stays in. Width alone is still the wrong test. iPhone 17 Pro landscape is 874px wide, and iPad Pro 11 portrait is 834px wide.

## Where they sit

Both insets are at least a 44px hit target, and `position: absolute` so they do not reflow the phone layout. On a phone the buttons stay `hidden`, `data-iss-split` stays off, and the ISS scene keeps today's padding. The horizon inset is 222×144 on a viewport the gate accepts. The plan map fills the left column of the ISS pane. That column is `minmax(300px, 36%)`, so the cupola column stays wider. The plan map's area is at least three times 148×96, and `letterboxCamera` keeps the fitted zoom so a tall column does not clip the track. The plan map sits above Telemetry and the Launch menu.

### Map view, the horizon inset

The resting place is the same on iPad Pro 11 portrait (834×1194), iPad Pro 11 landscape (1194×834 and a Safari tab at 1194×710), and desktop (1280×800, and a laptop window at 1280×700). It is the top-right corner of the map pane. Its top is `--horizon-top` (`calc(var(--topbar-height) + 5px)`), under the top bar. The top left stays the Show toolbar and `.maplibregl-ctrl-top-left` (the MapLibre zoom and compass). The Bearing and Layers dock stacks below the inset, with the same 12px right edge. Legend sits immediately left of Hide. Both share `--map-corner-bottom`, which keeps the safe-area inset.

Hide stays 88×44 at `right: 12px`. It does not move between Controls and Hide. The inset's right edge is the same 12px. A signed-out banner with actions lifts Hide and Legend together to `7.75rem` plus the bottom safe area. The inset stays in the top corner.

The strip's right edge is `--map-corner-clear` (204px), so it stops before Legend and Hide. Its padding-right is 8px on a fitting viewport, because those two buttons are outside the strip. The slider row is at least 8rem and the slider itself is 32px tall. The skip buttons stay 44px so they still share Hide's vertical center. Below 520px the short-landscape rules still own the 52px row and `--map-command-bottom`. That query cannot match the gate, so the preview stays off. Legend and Hide still share `--map-corner-bottom`, including the shoot-list lift.

The inset hides while the pin inspector is open, while the satellite picker is open, and while map chrome is hidden (`#map-pane.map-chrome-hidden`). It returns when they open again. Activating the button focuses `#tab-iss` before the view changes, so Enter and Space do not leave focus on `body`.

### ISS view, the plan inset

The plan map is the left column of `#iss-pane`. The cupola scene is the right column, and that column is the wider one. Telemetry and the Launch menu sit in `[data-iss-split-dock]`, under the map. The clock and `Expedition 75 Beta Edition` sit in `[data-iss-split-chrome]`, over the map. Port, Starboard, the field readout, and the hint stay on the cupola. The launch card stays with the earth. The help button is the bottom right of the viewport.

Fullscreen hides the split and moves the clock and the telemetry card back into the scene. The earth frame grows back to the fullscreen fit. Leaving fullscreen restores the two columns.

## What each inset must miss

A visible box counts. A `hidden` control or a `display: none` control does not.

On the map, the inset misses the top bar, the status line, the Show label and All, Mine, and Launches, `.maplibregl-ctrl-top-left`, the Bearing and Layers labels and their buttons, the time strip, the slider, Now and +36h, the readout, T-90, T-45, Now, T+45, and T+90, Hide, `#map-legend-toggle`, `#map-legend-panel`, the legend items, and the imagery note. The drive overlap list names `.maplibregl-ctrl-top-left`, `#map-legend-toggle`, and `#map-legend-panel` as their own selectors. `elementFromPoint` at each of those legend centers is not the inset.

On the ISS view, the plan map misses the top bar, the status line, the help button, Keyboard shortcuts, Full screen, Horizon, Straight down, the Cupola select, Port, Starboard, the field readout, the hint, the launch card, Telemetry, the Launch menu, the attribution button, and any place name on the earth. The clock and the edition line sit on the map. `elementFromPoint` on the UTC line and on the edition line hits `[data-iss-split-chrome]`.

## Rendering

The horizon inset calls `createIssRenderer` with `labels: false`, so it does not fetch the place-name catalog and does not lay out labels. That function keeps one module-level hook slot, so the inset exists only while the full ISS scene is disposed. Opening ISS view destroys the horizon inset first, then mounts the scene. The plan inset is a second mercator map, `createTrackInset`, drawing `groundTrackFeatures` and `markerPositionAt` from the existing track code. Its basemap is Esri World Dark Gray (`Canvas/World_Dark_Gray_Base`), the same raster the main map uses when clouds or IR replace World Imagery. It can sit beside the full horizon scene. Country names are the `inset-countries` symbol layer, twelve centroids drawn with the bundled Open Sans Regular glyphs at `/glyphs/Open%20Sans%20Regular/0-255.pbf`. The Esri `World_Boundaries_and_Places` raster stays underneath. Requested tile zoom is round(viewZoom + 1). Tile zoom 3, view zoom 1.5, is the first that names eleven of the twelve centroids. Kenya is absent on that tile and first named at tile zoom 4, view zoom 2.5. Each centroid symbol stops at that country's handoff, and a full orbit still uses the symbols. Stopping the symbol removes that extra symbol. The dark basemap and the reference raster can still overprint France or Japan. A fetch of that glyph file sets `data-inset-glyphs` to its byte length. `fitBounds` allows zoom 5, so a tighter track requests denser reference tiles. `letterboxCamera` keeps the fitted zoom, so a tall column does not raise it and clip the marker or the track.

Neither inset map is created when the gate fails, when its tab is not showing, when the document is hidden, or when ISS fullscreen is active. Updates are 1s for the ISS dot and the horizon aim, and 5s for the ground-track line. Leaving the tab or hiding the document destroys that inset map.
