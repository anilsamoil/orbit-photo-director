These PNGs are synthetic lettering for the plan name counter. They are not screenshots and they are not Esri tiles.

Each engine frame is 478 by 690. Chromium uses DejaVu Sans at 14px and WebKit at 15px. `main` paints two Latin KENYA words. `greek` replaces the second with ΚΕΝΥΑ, `accent` with KÉNYA, `cyrillic` with КЕНИЯ, `arabic` with كينيا (Noto Naskh/Sans Arabic), and `cjk` with 肯尼亚 (Droid Sans Fallback). `webkit-two-plus-greek.png` paints two Latin KENYA words and one ΚΕΝΥΑ.

Tesseract's English model reads ΚΕΝΥΑ and KÉNYA as KENYA. The counter still has to reject that ink.

`towns.png` is Nakuru, Nairobi, Nyeri, Embu, and Thika in the same DejaVu, with no country name.

Regenerate this directory with `node .cursor/skills/verify-opd/scripts/plan-label-synthetic.mjs`. The script uses the fonts in `fixtures/fonts` first, then Linux and macOS font paths.
