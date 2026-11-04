These PNGs are synthetic lettering for the plan name counter. They are not screenshots and they are not Esri tiles.

Each engine frame is 478 by 690. Chromium uses DejaVu Sans at 14px and WebKit at 15px. `main` paints two Latin KENYA words. `greek` replaces the second with ΚΕΝΥΑ, `accent` with KÉNYA, `cyrillic` with КЕНИЯ, `arabic` with كينيا (Noto Naskh/Sans Arabic), and `cjk` with 肯尼亚 (Droid Sans Fallback). `webkit-two-plus-greek.png` paints two Latin KENYA words and one ΚΕΝΥΑ.

Tesseract's English model reads ΚΕΝΥΑ and KÉNYA as KENYA. The counter still has to reject that ink.
