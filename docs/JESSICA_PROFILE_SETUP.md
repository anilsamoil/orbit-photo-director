# Jessica Meir map profile

The signed-in account remains separate from the selected shooting profile.
`/api/browser/session` returns the account default as `profile` and the complete
authorized chooser list as `profiles`, with the default first. A `?u=jessica`
link only selects Jessica when the verified session explicitly includes her.
Otherwise, the frontend opens the account's own profile. Every target and rating
request independently checks the same membership on the Worker.

`ACCESS_PROFILE_GRANTS` is a private Worker secret. It maps the same normalized
email SHA-256 keys used by `ACCESS_PROFILE_BINDINGS` to arrays of objects with
exactly `name` and `displayName` fields. A Jessica grant is
`{"name":"jessica","displayName":"Jessica Meir"}`. Do not put raw email
addresses or deployed hashes in source control. Missing grants preserve
own-profile-only behavior; malformed grants fail closed with HTTP 503.

The three existing owner aliases retain their Jessica management grants.
Jessica's exact Google sign-in email, supplied by the owner, is privately bound
to `jessica` as her default. Before that binding, remote inventories showed no
targets or ratings under an automatic account namespace; existing data was
retained. Her actual device login remains a user verification step. Any local
unsynced data stays on the device, so do not clear browser site data. Never
guess an email or an earlier account namespace from a name or URL.

The source-backed starter list is in `data/profiles/jessica/bootstrap.json`.
Research evidence is presented at `/profile-research/jessica.html`. Place
coordinates are broad city/landscape anchors, and suggested priorities are
editorial starting points rather than preferences confirmed by Jessica.
Population should append missing stable IDs, preserve existing targets and
verify server readback; the older full-list bootstrap PUT utility is intended
for reviewed replacement/recovery, not concurrent additive updates.

`generator.config.PROFILE_NAMES` includes `jessica`. The existing Earth daemon
fetches her saved targets and publishes per-profile artifacts on its normal
cycle. A saved pin is available immediately; scored Queue/Upcoming entries
require a completed generation and a qualifying pass. Personal-target lighting
regime remains `any`; day/night advice in the research notes is guidance, not a
new scoring filter. A place beyond the ISS ground-track latitude limit may be
visible obliquely, but that is not an overhead pass or a guaranteed photo.

Profile selection reloads the page to reset manifest and cache state. Offline
resume never restores chooser permissions and cannot sync. Existing additive
hydration preserves local edits and adds missing server IDs; it does not fully
reconcile remote edits/deletions over populated local records.
