# Mission Log

ISS-side test reports + screenshots from the operator (Chris Williams).

Append entries chronologically (newest at top). Each entry is one observation
session — could be 30 seconds of "page rendered fine during LOS" or a full
shot/skip log roundtrip. Both are useful data.

---

## Template

```
### YYYY-MM-DD — <one-line summary>
- **What was tested:** offline boot during LOS / shot log / PWA install / etc.
- **Result:** ✅ worked / ⚠️ worked with caveats / ❌ broke
- **What Chris saw:** <his words, paraphrased; quote if WhatsApp text>
- **Screenshot:** path or "sent via WhatsApp <date>" (don't commit raw imagery)
- **App version at time of test:** vX.Y.Z.W (read from page footer or visible build hash)
- **LOS / AOS context:** in LOS / 5 min into LOS / just-back-from-LOS / signal full
- **Follow-up:** <none / file as TODO / fix immediately>
```

---

## Entries

### 2026-05-10 — Sun May 10, ~10:18 UTC: queue showing all-past cards (ship-blocker UX bug)
- **What was tested:** Chris opened the live site, switched to Queue + Upcoming tabs, reported what he saw.
- **Result:** ⚠️ worked with one bug + UX questions. App generally functional, crew shown it, "they think it is awesome." Bug found: all 4 visible Queue cards tagged "Past."
- **What Chris saw:** "Seems to be working! I think I don't fully understand the queue vs upcoming and the scoring, but it generally makes sense! Occasionally, all of the queue items will be in the past — not sure why. But it generally seems very sound! I showed it to the other folks on the crew too and they think it is awesome! I haven't had a chance to try shooting a target yet — I'll do a test one tomorrow just to try."
- **Screenshot:** sent via WhatsApp 2026-05-10 18:44 PT. Two iPad screenshots: Queue tab (4 cards all "Past": Salt Lake City, Blue Origin HQ, Seattle/Portland, Starbase) and Upcoming tab (5 cards all in future: Minneapolis ×2, India megaregion, Saint Paul, Persian Gulf).
- **App version at time of test:** v1.1.0.1 (Lane F SW). Banner read "Last updated 46 min ago" (yellow) → "generator running slow" (Upcoming screenshot showed "Last updated 1h 42m ago — generator running slow").
- **LOS / AOS context:** Manifest age 46-102 min suggests Chris was inside an LOS window OR generator was lagging on the Mac side. Either way, the past-cards bug is independent of LOS state.
- **Follow-up:**
  - ✅ FIXED in v1.1.0.2 (`fix: hide already-happened passes from Queue + Upcoming`, PR #4 merged + R2-deployed 2026-05-10). Frontend now filters past cards at render time + on the 1Hz tick. When Queue empties due to filtering, the existing "No passes in the next 90 minutes." empty state shows.
  - 📋 Filed as TODOs: Queue vs Upcoming explanatory copy, scoring breakdown popover.
  - Crew members seeing it = social proof that earns more iteration budget.

### 2026-05-05 — Initial token + first impressions
- **What was tested:** Chris received the WhatsApp test plan + token, set the token in the page UI, opened the site.
- **Result:** ✅ worked.
- **What Chris saw:** "Dude — this is incredible! Great work. I put in my token and will try it out!"
- **Screenshot:** none (text-only reply).
- **App version at time of test:** v1.1.0.1 (Lane F SW just deployed).
- **LOS / AOS context:** unknown (likely AOS at message time).
- **Follow-up:** filed 4 V4-P2 TODOs from his follow-up message (map zoom-in, rotate-to-ISS-track, aurora forecast, pre-cache tiles for upcoming targets).
