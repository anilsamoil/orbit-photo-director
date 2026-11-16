# Decisions

One line per decision made after the design doc: the date, the decision, the reason. Newest last. Decisions D-1 to D-10 are in [the design doc](../designs/ios-app.md) and are not repeated here.

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-16 | The owner approved the design: a native shell first, native pieces later. | The approach and its premises were confirmed one by one during planning. |
| 2026-11-16 | Testing runs in simulators on GitHub's Macs, plus one real device on Earth before anything goes to orbit. Added W-74, ad hoc install over the air. | The owner could not get TestFlight onto the iPad in orbit. |
| 2026-11-16 | The route to orbit is the unlisted App Store listing. TestFlight serves the ground tester only. | The App Store on that iPad refuses TestFlight, while other App Store apps install. |
| 2026-11-16 | After the independent spec review: the device queue starts from now, not from the end of the published horizon; added W-03 (signed host proof on a ground device), W-63 (old builds keep working), the update step in G2 and G3, month-independent log dedupe in W-20, and the orbit device details as an owner step. | 13 blocking review findings, recorded in the design doc. |
