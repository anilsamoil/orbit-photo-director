These PNGs are synthetic lettering for the plan name counter. They are not Esri tiles and they contain no map imagery.

Credit: the glyphs are DejaVu Sans, drawn locally. `canada-main.png`, `canada-painted-out.png`, and `canada-duplicated.png` are the same drawing, committed so the Canada check does not need Pillow, a font path, or a temp directory.

Regenerate the Kenya-west set with `node .cursor/skills/verify-opd/scripts/plan-label-regression.mjs`. Regenerate the three Canada frames with `node .cursor/skills/verify-opd/scripts/plan-label-synthetic.mjs`.
