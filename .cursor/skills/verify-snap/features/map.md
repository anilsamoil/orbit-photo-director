# Map

Map is the MapLibre view of the ISS ground track, targets, and overlays; the time slider scrubs the next 36 hours.

## Sub-features

- `map-open` opens the Map tab and lazy-loads MapLibre.
- `map-scrub` moves the time slider / step buttons away from Now.
- `map-overlays` toggles clouds, IR, terminator, night lights, labels, multi-orbit.
- `map-follow` recenters on the ISS marker.
- `map-filter` toggles All / Mine / Launches on the map toolbar.

## How to get to it (user POV)

- Choose the `Map` button in the topbar tabs.
- From a queue card, map-related actions may also focus the map (verify via the Map tab entry for this skill).

## Driving it with control-snap

Preconditions:

- Instance healthy per doctor.
- Fixture track artifact present (VERIFY).

- **Open Map.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id tab-map`. `#view` is `view-map`; `#map` exists in the DOM.
- **Scrub forward.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id time-fwd-45`. `#time-fwd-45` becomes `active` (or readout leaves `Now`).
- **Return to Now.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id time-now`. `#time-now` is `active`.
- **Toggle terminator.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id toggle-terminator`. Button `active` class toggles.
- **Follow ISS.** Run `.cursor/skills/verify-snap/helpers/control-snap.mjs browser click --id toggle-follow-iss`. Control shows pressed/active state per UI.
- **Proof.** `.cursor/skills/verify-snap/helpers/control-snap.mjs browser snapshot --aria --path .cursor/skills/verify-snap/artifacts/map/map.aria.json` and `browser screenshot --path .cursor/skills/verify-snap/artifacts/map/map.png` with Map tab active and SNAP brand visible.

## Gotchas

- MapLibre loads lazily on first Map click — wait for `#map .maplibregl-canvas` (or non-empty map container) before asserting overlays.
- Basemap tiles need network (Carto/Esri); offline runs may show a dark map while controls still work.
- IR and night-lights fetch external imagery; treat tile paint as best-effort, control state as the hard assertion.
- Launches filter needs launch artifacts; without them the control still toggles but no launch pins appear.
