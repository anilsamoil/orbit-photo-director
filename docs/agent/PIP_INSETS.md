# Picture-in-picture insets

The map inset and the horizon inset are previews. A tap on one opens the view it shows. Phones do not get them, and the phone layout does not change.

## Gate

Show an inset only when both viewport axes are at least 800px. The check is `matchMedia('(min-width: 800px) and (min-height: 800px)')` plus the same test on `innerWidth` and `innerHeight` before any inset map is created. It is not a user-agent test.

The shorter side is what separates the devices. iPhone 13 and iPhone 17 Pro stop at 402px on the short side, in portrait and in landscape. iPad Pro 11 is 834px on the short side, in both orientations. A desktop window of 1280×800 is 800px on the short side. Width alone is the wrong test. iPhone 17 Pro landscape is 874px wide, and iPad Pro 11 portrait is 834px wide, so a width gate would show the inset on that phone and hide it on that iPad.

## Where they sit

Both insets are 148×96 CSS pixels, at least a 44px hit target, and `position: absolute` so they do not reflow the phone layout. On a phone the buttons stay `hidden` and the ISS scene keeps today's padding.

### Map view, the horizon inset

The resting place is the same on iPad Pro 11 portrait (834×1194), iPad Pro 11 landscape (1194×834), and desktop (1280×800 and larger). It is not a corner. With the controls open, every corner is taken. The top left is the Show toolbar and the zoom control. The top right is the Bearing and Layers dock. The bottom left is the legend, and a later change turns that legend into a tab on the left edge. The bottom edge is the time strip, and the bottom right is the Hide button.

The inset sits just left of the dock and just above the time strip.

- `right: 112px`. The dock is at most 76px wide and 8px from the right, so its left edge is about 84px from the right. The Hide button is 88px wide and 12px from the right, so it occupies out to 100px from the right. 112px leaves a gap beside both.
- `bottom: calc(var(--map-command-height) + 36px)`. With the controls open the strip is 140px tall, so the inset is above the slider, the skip buttons, the imagery note, and the Hide button. With the controls closed the command height is 0 and the same `right` still clears the Controls button, which does not move.

The inset hides while the pin inspector is open and while the satellite picker is open, because both can cover that band. It returns when they close.

### ISS view, the plan inset

The resting place is the bottom left of the ISS pane, 12px from the left and 12px from the bottom. iPad portrait has a tall empty band under the Telemetry row. iPad landscape and desktop do not, so when the gate matches, the scene gains `padding-bottom: 7.75rem` and the earth frame shrinks into the space above that band. The inset sits in the band.

That band is below the Telemetry button, the Launch menu, and the launch card. The card sits beside the earth on these widths. Port and Starboard stay beside the frame. The clock, the edition line, the field readout, and the hint stay on the toolbar or on the frame. The help button is the bottom right of the viewport. The inset is the bottom left of the pane.

Fullscreen removes the extra padding and hides the inset. The earth frame grows back to the fullscreen fit. Leaving fullscreen restores the band and the inset.

## What each inset must miss

A visible box counts. A `hidden` control or a `display: none` control does not.

On the map, the inset misses the top bar, the status line, the Show label and All, Mine, and Launches, the zoom control, the Bearing and Layers labels and their buttons, the time strip, the slider, Now and +36h, the readout, T-90, T-45, Now, T+45, and T+90, Hide, the legend and its four items, and the imagery note.

On the ISS view, the inset misses the top bar, the status line, the help button, Keyboard shortcuts, Full screen, Horizon, Straight down, the Cupola select, the five clock lines, the edition line, Port, Starboard, the field readout, the hint, the launch card, Telemetry, the Launch menu, the attribution button, and any place name on the earth.

## Rendering

The horizon inset calls `createIssRenderer`. That function keeps one module-level hook slot, so the inset exists only while the full ISS scene is disposed. Opening ISS view destroys the horizon inset first, then mounts the scene. The plan inset is a second mercator map, `createTrackInset`, drawing `groundTrackFeatures` and `markerPositionAt` from the existing track code. It can sit beside the full horizon scene.

Neither inset map is created when the gate fails, when its tab is not showing, when the document is hidden, or when ISS fullscreen is active. Updates are 1s for the ISS dot and the horizon aim, and 5s for the ground-track line. Leaving the tab or hiding the document destroys that inset map.
