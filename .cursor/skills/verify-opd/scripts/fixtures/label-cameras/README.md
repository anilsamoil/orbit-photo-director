These three PNGs are screenshots of the plan column, 274 by 984, kept so the glyph counter can be checked without a browser.

`kenya-west-37-1.png` is the plan inset at 37E, 1N. It was committed in `565750c`. `nigeria-east-9-10.png` is 9E, 10N and `nigeria-diagonal-8.5-11.png` is 8.5E, 11N. Those two were committed in `ee2112f`.

The lettering is the plan's own raster text. These files are not redrawn type and they are not Esri tile exports.

Each file is a `Page.captureScreenshot` of the plan inset canvas, 274 by 984, after the marker is hidden and the track layers are turned off. The Kenya frame was saved in `565750c`. The two Nigeria frames were saved in `ee2112f`. The PNGs carry no browser or OS metadata. The capture steps are `capturePlanCanvas` in `drive.mjs`.
