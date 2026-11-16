# SNAP for iPhone and iPad: owner steps

The things only the owner can do. Everything else is the agents' work. The steps are in order. Steps 1 to 4 can all start today. None of them blocks the agents from starting; they block the first signed build.

Agents never create, read or move Apple credentials. Where a step produces a key, the owner places it and no one else sees it.

## 1. Test the install path (ten minutes, no account needed)

On the iPad in orbit, install the TestFlight app from the App Store. Then download any one app from the App Store and note its size and how long it took.

**Why:** it proves apps can be installed over the station link, and the timing sets how big SNAP may be.
**Send back:** the app's size and the minutes it took.

**Answered 2026-11-16:**

- The devices are an iPad Pro with M4 and an iPhone 17 Pro. Both are managed: every app needs approval from the agency's device management before it can be installed. TestFlight will not be approved, so it is only for the ground tester.
- Storage and download size are not constraints. Large downloads run overnight.
- The iPad is the 11-inch model on iPadOS 26.6.2. The iPhone runs iOS 26.6.1.

## 2. Apple Developer Program

Check whether the membership is active at developer.apple.com/account. If not, enroll as an individual. It needs an Apple ID with two-factor sign-in and costs 99 US dollars a year. Enrollment can also be done in the Apple Developer app on an iPhone or iPad.

**Why:** signing and TestFlight need it. Approval can take a day or more, so it is the longest wait in the plan.
**Send back:** "active" or "enrolled on" and the date.

**Done 2026-11-16:** the membership is active.

## 3. The app record and the key

In App Store Connect:

1. Create the app. Pick a bundle identifier, for example `dev.astroanil.snap`, and a name. "SNAP" alone is probably taken as a store name; "SNAP Orbit Photo Director" is a candidate.
2. Add yourself to an internal TestFlight group.
3. Under Users and Access, Integrations, App Store Connect API, create a key with the App Manager role. Download the key file. Apple shows it once.

Then on GitHub, in the repository's Settings, Environments: create an environment named `ios-release`, set yourself as its required reviewer, and add the key's three values as secrets of that environment. Name the three secrets `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID` and `APP_STORE_CONNECT_PRIVATE_KEY` (the whole text of the downloaded `.p8` file). W-03 and W-70 read these names.

**Why:** the release job signs and uploads with this key. Keeping it in a protected environment means no build can be signed without your approval.
**Send back:** the bundle identifier and the name. Never the key.

## 4. A ground tester

Name one person on Earth with an iPhone or iPad who can spend ten minutes on a checklist before a build goes to orbit. Add them in App Store Connect as a user on your team and an internal TestFlight tester: internal testers get builds with no Beta App Review, which W-03 needs.

**Why:** nobody can attach a cable to the iPad in orbit. A build that fails on the ground costs minutes. One that fails in orbit costs days.

**Done 2026-11-16:** the owner named the ground tester. The name is kept out of this public repository.

## 4a. Approval for the managed devices

Once the app is in the App Store, ask NASA to approve SNAP and install it on the iPad and the iPhone in orbit. The agents prepare an approval packet with W-71: what the app does, every server it contacts, what it stores, the one permission it asks for (notifications), and that it has no tracking and no third-party analytics.

Ask them one question early: do they want SNAP as an unlisted App Store app that they approve, or as a custom app sent to the agency's Apple Business Manager, which their device management then installs? Both go through App Review. The second lets them push the app and its updates themselves.

**Why:** no build reaches orbit without this approval. It may take longer than any code.
**Send back:** which of the two they prefer, and anything they need in the packet.

## 5. Xcode on the Mac (optional)

Decide whether Xcode goes on the Mac on Earth. It needs your Apple ID sign-in once and roughly 20 to 25 GB with a simulator. The agents can finish the setup after that.

**Why:** with it the agents can run the app in a simulator while they work, which is faster. Without it every app build runs on GitHub's Macs, which works and is slower.
**Send back:** yes or no.

## 6. Approve device access (after the security review of W-20)

When the organizer reports that the device-access design passed its review:

1. Approve a Cloudflare Access bypass application for the path `/d/*` on both map hosts.
2. Approve the Worker deploy.

**Why:** this is what replaces the sign-in cookie that expired on you. It is the security-sensitive part of the plan, so it waits for a review and for you.

## 7. Decisions to send back when convenient

- Who may create an account: the plan's default is that Google accounts on the existing email allowlist sign in at once and every other account, including Apple IDs, waits for your one-time approval in the device list. The alternative is open sign-up for anyone.

- Alert defaults: how many minutes before a target, which targets (all, yours, launches), and a sleep window with no alerts.
- Esri map layers: keep exactly the tiles the website keeps today, never bundled (the plan's default), or ask Esri about offline rights.
- When crewmates get the app. The plan's default is after fourteen days of your own use with no lockout and no lost log.

## 8. Each release

Approve the release job when the organizer asks. Submit the App Store build for review when the organizer has the folder ready (W-71); after approval, install or update SNAP from its unlisted App Store link. The ground tester installs from TestFlight.

**Why:** the App Store is the one install channel that works on the iPad in orbit. App Store builds do not expire. The website stays as the fallback either way.
