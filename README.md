# Core Defense — milestone 5 (economy measurement patch)
This version adds Tank, Swarm and Tiny enemies, reserved enemy capacity, Core Repair and Spawner cooldown diagnostics. It also corrects scoring/Freezer assists and makes unpaid upkeep visible. Existing placement, ownership, selling, shared treasury, reconnect and local/cross-origin transport remain intact. Existing enemy/tower costs, HP, speeds, income and spawn cooldowns have not been tuned. Surge, role selection/rotation, end-screen MVPs and Play Again remain later work. Nothing was deployed.

Version 0.5.1 adds opt-in upkeep scaling, complete match economy records and a simulator driven by the live engine. Live defaults remain unchanged. This is still milestone 5.

## Run locally
Install Node.js 22 or 24 (Node 24 is recommended). Stop the previous server, extract this project and open a terminal in the folder containing package.json.

```sh
npm ci
npm start
```

Open http://localhost:3000. GET http://localhost:3000/health returns plain text `ok`.
To use another port, set the PORT environment variable before starting.
Run `npm test` for deterministic engine, client and real Socket.IO tests.
For the phone test, reuse the same working address and allowed-origin configuration that passed milestone 4; use landscape. Origin rules are unchanged.

## Normal + incognito test
1. In a normal window open the base URL, enter a nickname and create a room. This player is Spawner and host. In incognito open the BASE URL separately (do not copy the player-specific URL), enter another nickname and join with the code. This player is Defender. Keep the incognito session open for refresh testing.
2. Start from the host. Both screens show the 10-second countdown, frozen money and a five-minute match timer. No spawning, placement, selling or Repair works until play starts. Then the headings say Attack the Core and Defend the Core respectively. Only the Spawner gets enemy buttons; only the Defender gets tower/sell/Repair controls.
3. Defender: select Shooter, tap the top ring point (point 13 directly below gate 1), then Confirm Placement. Selection alone does not spend. The tower costs 50, appears cyan to its owner and lavender to others, and records a shared spend-feed entry. Spawner: leave Runner selected, click top gate 1. Expect an immediate 20 charge, 1.5-second per-type cooldown, two-second warning, then a Runner. It dies in two Shooter hits: 20 actual damage, 1 kill, **25 points** to the owner and **6 bounty** to the shared treasury. Passive income continues, so the treasury also changes between snapshots.
4. Send a Runner from unguarded bottom gate 3. About 5.1 seconds after acceptance, Core HP drops to 97; Spawner gets +5 money and **15 points** for 3 actual Core damage. Defender: click Core Repair. It costs the full **60**, heals **3** to 100, awards **10 points**, and starts the **20-second shared cooldown**. The spend feed says who repaired and how much was healed. At full HP it is disabled/rejected without charge. Send another Runner during the cooldown: Repair stays blocked even when the Core is damaged again.
5. Refresh both CURRENT URLs during active play, one at a time. Expect the same identity, role, towers, scores, enemy warnings, shared Repair cooldown and Spawner diagnostic totals; no duplicate player, purchase or reset. Tower selection/inspection is cleared. Reclaim within 120 seconds while the original room still exists. Host may transfer to the other connected player and is not automatically reclaimed. A countdown disconnect deliberately returns the room to the lobby; a playing-phase disconnect does not pause it.
6. To test another setup, open the base URL and create a fresh room. A third browser/profile joining BEFORE Start gives a second Defender. New arrivals after Start are spectators. Play Again is not implemented yet.

Browser storage must be allowed. Use the same origin consistently: localhost and 127.0.0.1 have different storage. A copied player URL without its locally stored token cannot reclaim that player. Closing all private windows clears their storage.

## New enemies and Swarm edge cases
Use a fresh room per setup, with no unrelated attackers/towers so score and bounty changes can be attributed.

| Enemy | Spawn cost | HP | Speed (px/s) | Core damage | Cooldown (s) | Kill bounty | Kill points |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Runner | 20 | 20 | 120 | 3 | 1.5 | 6 | 20 |
| Tank | 80 | 300 | 35 | 15 | 8 | 24 | 20 |
| Swarm parent | 60 | 100 | 65 | 0 (splits first) | 6 | 18 on tower kill only | 20 on tower kill only |
| Tiny | Not directly spawnable | 15 | 90 | 2 | — | 1 | 5 |

1. **Tank:** choose Tank, then top gate 1. Cost 80 and its eight-second cooldown begin at acceptance. After the two-second warning, a visibly larger Tank with a 300-HP bar moves at 35px/sec. In an undefended lane it reaches the Core after about 12.6 seconds including warning, deals 15 and disappears. Spawner gets 75 score and +5 money. A full-health Tank killed entirely by one owner's towers gives that owner 95 points (300 × 0.25 + 20) and treasury +24.
2. **Automatic split:** no towers. Choose Swarm and gate 1. After two seconds it appears, then splits at or inside 150px from the Core (about 5.4 seconds after acceptance). The parent disappears and five 15-HP Tinies appear at its position. Coincident Tinies show **Tiny ×5**; each is still an independent server enemy. No 18 bounty or parent kill credit is awarded. Slot use stays at 5. If ignored, the five Tinies deal 10 total Core damage; Spawner earns 50 score and +25 hit income.
3. **Tower-kill split:** place a Cannon at top point 13; wait until the treasury can afford a second Cannon, then place it at adjacent point 12 (upper-left). Start the attack only after both exist. Send one Swarm from top gate 1. The Cannons kill its parent before the 150px line, paying **18** and creating all five Tinies at the parent's location. The killing shot does not also damage newly created children; later shots, including another tower later that tick, can. A later Cannon splash kills all five for another **5 total bounty**. One owner of both Cannons ends with **6 kills, 175 actual damage and 88.75 points**, with Core HP 100. Combined bounty is **23**, less than a Tank's 24. Income and upkeep are additional treasury changes.
4. **Same-tick boundary:** movement/proximity splitting happens before tower fire. If the parent enters 150px on the same tick a Cannon becomes ready, it splits automatically first: no parent bounty or kill; the Cannon may then hit the Tinies. Existing parent damage credit remains. Children start at full HP with no inherited slow or assist timer.
5. **Capacity:** HUD shows weighted **Enemy slots: used / 80**, including warnings. Each Runner/Tank/Tiny uses 1. Each pending or living Swarm consumes **5 total slots**, reserving its eventual children; it does not consume 6. At 75 used, one Swarm is accepted and reserves the remaining 5 immediately. At 76 used, Swarm is blocked but a one-slot enemy may fit. At 80 all spawns are blocked. Rejected spawns take neither money nor cooldown. Both split paths replace the parent's five-slot reservation with exactly five Tinies, even at full capacity; kills/Core hits release slots. Sixteen pending Swarms reserve all 80 slots and can later become 80 Tinies without overflow.

The 75/76/80 boundaries are hard to reach with normal income and cooldowns. Test them without changing gameplay config or exposing debug controls:

```sh
node --test test/enemies.test.js test/repair-diagnostics.test.js test/scoring-corrections.test.js
```

These fixtures exercise both split paths at capacity, same-tick proximity/shot ordering, no double bounty, partial Repair, exact cooldown expiry, award caps and upkeep recovery against the real server engine. They are deterministic rule tests, not balance simulations.

## Corrected scoring, selling and upkeep
All numeric rules are in `shared/config.js`.

| Rule | Implemented behavior |
| --- | --- |
| Damage / kills | 0.25 points per actual HP removed; 20 per Runner/Tank/Swarm parent killed; 5 per Tiny killed. No overkill credit. Credit belongs to the tower owner; bounty goes to the shared treasury. Scores remain after sale or owner disconnect. |
| Spawner / Repair / win | 5 points per actual Core HP removed; Repair actor gets 10 per accepted Repair even for a partial heal; winning match participants get +100 once. Spectators get no bonus. Original participant scores remain eligible after disconnect/slot expiry. Existing end triggers are Core destruction or time expiry; no new forfeit flow was added. |
| Freezer assist | 2 points immediately per eligible enemy per slow application; no kill required. At most one award per enemy every 2 seconds across all Freezers, and at most 10 points per Freezer in a rolling 1-second window. Simultaneous claims use tower placement order. Limits restrict points, not slow application. Killing the enemy awards no extra assist. Selling a source does not reset the enemy's award timer. |
| Freezer effect | Every enemy in range receives the pulse. Strongest active slow wins; 50% speed for 2 seconds, refreshed by a pulse once per second. Overlap never produces 25% speed. Sold towers' existing slows finish their remaining duration. |
| Owner-only selling | Only the original owner can sell after the 1-second lock. No host/other-Defender exception, even if the owner disconnects or expires. Unclaimed towers remain until match end. Refund is 50% of the actual original purchase price into the shared treasury, once per tower ID. |
| Sell-and-rebuy economics | The transaction itself always loses money: Shooter −25, Cannon −60, Freezer −45. Rebuy pays full price and resets the sell lock/firing/upkeep schedule, but never refunds more or awards points. Passive income and bounties are separate earnings, not profit from selling. Buying a fresh Cannon can fire sooner, but costs 60 net; there is no free cooldown reset. |
| Upkeep | Default: 1 per tower every 10 seconds from placement. Optional slope is off (0); see the experiment section below. Income arrives before billing. If unpaid, tower stops firing/pulsing and shows gray **PAUSED** on the map plus **paused: can't pay upkeep** with point/owner in the status list and inspector. It retries at its next bill, not immediately upon new income; no debt/partial charge. Successful payment resumes it and adds a spend-feed note. Same-tick bills use placement order. |
| Core Repair | Any Defender may pay 60 from shared treasury to heal up to 5, never over 100. Full HP rejects without charge or cooldown. Shared cooldown is 20 seconds from acceptance. Simultaneous requests are serialized: one valid action charges/heals/scores once, others fail. |
| Cannon | Cost 120, range 150, damage 80, 0.5 shots/sec, 45px splash. Primary target is closest to Core in range; splash hits enemies inside the target-centered circle even outside tower range. |
| Shooter | Cost 50, range 120, damage 12, 2 shots/sec. Closest-to-Core target in range, ties by lower enemy ID. |
| Tick order | Diagnostic sampling, clock/income, due upkeep, enemy movement/Core hits/proximity splits, warning release, Freezer pulses, damage towers, win/lose. New enemies do not move on their release/split tick. Core destruction on the final tick gives Spawner the win. |

Retest a Freezer at point 13 plus a Shooter at point 12 against one top Runner: Freezer owner gets **2 points / 1 awarded slow assist**, Shooter owner gets **25 points / 20 damage / 1 kill**; if one player owns both, total is **27**. Overlapping Freezers do not duplicate the same enemy's award within two seconds. A Freezer slowing five fresh Tinies can award 10 points immediately, even before any are killed.

Inspect / Sell still names the owner and enforces the lock. Refunds are +25/+60/+45. Refresh must preserve ownership, scores, sell-lock age, upkeep schedule, slow expiry and assist award limits. Automated fixtures force unpaid upkeep and a later paid bill to check the pause/resume transitions exactly; ordinary income can make this situation uncommon in manual play.

## Spawner cooldown diagnostics (no tuning)
Each Spawner enemy button shows its price and **Ready**, **N seconds cooldown**, **Not enough money: need X**, and/or **Enemy cap: needs X slots**. Multiple simultaneous blocks are shown. Buttons and gates remain unavailable outside play or while reconnecting. Selecting an enabled enemy type does not spend; clicking a gate does. Cooldowns are per type across all eight gates, never per gate. Cost, cooldown and capacity reservation start at accepted click, not after the visible two-second typed gate warning.

The Spawner sees running **Affordable cooldown time** for each type, plus **All affordable types blocked**. The server accumulates integer 30-Hz ticks and converts to seconds:

- `perTypeSeconds`: money is enough for that type, capacity can fit it, but its cooldown is not ready. Other types may still be usable.
- `anyTypeSeconds`: time when at least one type meets that condition; overlapping type intervals count once.
- `allAffordableSeconds`: at least one type is affordable and every affordable type fits capacity but is on cooldown. This measures total cooldown lockout rather than restriction on one preferred type.

Cap blocks, countdown, lobby and finished time are excluded. These are availability measures, not an inference that the human tried to click; they continue while the Spawner is disconnected. They survive refresh and freeze at match end. No balance value is changed by the measurements.

The Node terminal writes one JSON record per completed match with `event: "spawner-cooldown-summary"`, room code, end reason, winner, fixed Defender count, elapsed match seconds and all three cooldown totals. The same record now includes `economy` with 30-second money samples and both sides' income/spending ledgers. If all reconnect reservations expire before completion, it instead logs an incomplete `endedBy: "room-empty"` record with `winner: null`; exclude it when comparing complete matches. Process crashes/restarts cannot recover unsaved in-memory metrics. Keep the terminal output for playtesting. No tokens or nicknames are logged by this diagnostic.

## Scope and configuration
- Shared config supplies map, Core/ring, 16 snap points, 8 gates, all combat/economy/scoring/repair/cap/timing/rate values and drawing dimensions. Server/browser use the same file. `balance_sim.js` now drives `server/game.js` directly and contains only bot decisions/reporting, with no duplicate combat rules.
- Fixed 30-Hz server loop, 15-Hz full snapshots, 100ms client interpolation buffer. Clients render results; they never decide damage, money or wins. Movement freezes on snapshot gaps rather than predicting outcomes.
- Spawn, placement, sell and Repair each have a separate 4/sec/player attempt limit including rejects, surviving reconnect. All enemy types and the legacy Runner action share one spawn bucket. General requests are limited to 10/sec/connection.
- Placement uses the 16 fixed snap points with no Defender-count scaling cap. First valid request wins a contested point; actions are validated synchronously against shared money/roles/state. Client-supplied prices, damage and ownership are ignored.
- N is fixed at start. Defender treasury starts at 150 + 10 per extra Defender, earns 5/sec. Spawner starts at 150, earns 4 + 0.5N/sec and +5 per enemy Core hit. No income during countdown or after finish. Scores do not create personal wallets.
- Latest eight placement/sale/Repair/upkeep-transition entries appear in the shared feed. Upkeep rate is in the HUD; next tower bill is in its inspector. Core HP is rounded up for display. Nicknames use textContent; reconnect secrets never appear in shared snapshots.
- Stable playerId plus localStorage token preserves a disconnected slot for 120 seconds. Active matches continue, host transfers, new arrivals are spectators, and rooms stay in one server process. /health remains public. No move-preview or player markers.

## Economy experiments and match logs

The only live experiment controls are in `shared/config.js`:

- `upkeep.upkeepSlope: 0` (off). Each tower's bill is `upkeep.cost * (1 + max(0, towerCount - upkeep.scaleAfterTowers) * upkeep.upkeepSlope)`. `scaleAfterTowers` is 8; the existing base bill is 1 every 10 seconds. At slope 0.125, sixteen towers each pay 2 per bill, a team total of 32 per ten seconds. All placed towers count, including paused/disconnected-owner towers. The count is evaluated when each bill is due. Existing billing schedules, pause/retry/no-debt rules and owner-only sales are unchanged.
- `economy.coreHitReward: 5` already existed and remains 5. The experiment reuses it rather than introducing a second reward value. It is money per enemy that actually hits the Core, independent of the score multiplier for Core damage.

The client upkeep HUD uses the server-provided bill, so it stays correct if you later opt into an experiment. No experimental value is applied to the default playable game by running the simulator.

`node balance_sim.js` runs three separate settings: current, slope 0.125 with reward 5, and reward 10 with slope 0. By default it runs spread Defenders against five Spawner scripts, at N=1/3/7, with 50 paired seeds each: 2,250 matches total. Config is cloned per experiment; live defaults are never mutated. It runs the actual 30-Hz engine, including capacity reservations, Freezer pulses, immediate death checks and correct opposite-gate selection. There is no Surge because the playable engine does not yet have it.

```sh
node balance_sim.js > reports/economy-comparison.json
```

The included [comparison report](reports/economy-comparison.md) gives all five-minute and early-ending results. Raw JSON includes every match, seed, cash sample and ledger, plus source hashes. `results[].atFiveMinutes` averages only matches that reached 300 seconds; `results[].earlyEndings` contains their actual earlier end times/balances. Missing groups have count 0 and null means, never fabricated zero balances. A loss exactly at 300 seconds still belongs to the five-minute group. Survivors can differ across settings.

To run a quick subset, use:

```sh
node balance_sim.js --runs=5 --settings=current --spawners=human-like --ns=1,3,7
```

Settings names: `current`, `upkeepSlope0125`, `coreHitReward10`. `--defenders=spread,clustered,lazy` enables the original clustering stress test and six-tower strategy. The included report uses spread only. Bots use one team controller and ten decisions/sec, respect action rate limits, purchase before Repair, and do not reproduce human coordination. This is simulated evidence, not local human playtest data.

### Capture and read a local match log

In PowerShell, run the unchanged game while keeping a log:

```powershell
npm start | Tee-Object -FilePath playtest.log
```

At match end, find the JSON line whose `event` is `spawner-cooldown-summary`. Normal npm/startup messages are not JSON records. This keeps the earlier event name/cooldown fields and appends `economy`:

| Field | Meaning |
| --- | --- |
| `elapsedSeconds`, `endedBy`, `winner`, `defenders` | Actual match duration, completed/incomplete reason, winning role, fixed N. Use `endedBy = match-finished` for completed-match comparisons. `room-empty` means an abandoned match whose reconnect reservations expired. |
| `economy.settings` | The actual upkeep slope and Core-hit money reward used. |
| `economy.samples` | `{seconds, treasury, spawnerMoney}` at 0, 30, 60, ... using match time. No countdown income. Samples are taken after the server tick, including its income, upkeep and combat. The history is written at match end, not as a new line every 30 seconds. |
| `economy.defenders`, `economy.spawner` | Each side's `startingBalance`, categorized `income` and `spent`, `totalIncome`, `totalSpent`, and `finalBalance`. |
| Defender income | `passive`, `bounties`, `saleRefunds`. Refunds are counted as credited income; purchases remain full spending. |
| Defender spending | `towers`, actually paid `upkeep`, and accepted `repairs`. Rejections and unpaid bills add no spending/debt. |
| Spawner income / spending | `passive` and `coreHits`; `enemies` records accepted spawn costs at click time. |

For each side, `startingBalance + totalIncome - totalSpent = finalBalance` within floating-point precision. Starting money is not counted again as income. Scores and winning bonuses are points, not money. The JSON rounds money to eight decimal places; the HUD still displays whole credits.

Read the last record in a second PowerShell window:

```powershell
$match = Get-Content .\playtest.log | Where-Object { $_.StartsWith('{"event":"spawner-cooldown-summary"') } | Select-Object -Last 1 | ConvertFrom-Json
$match.economy.samples | Format-Table
$match.economy.defenders | ConvertTo-Json -Depth 4
$match.economy.spawner | ConvertTo-Json -Depth 4
```

A match ending at 64.9 seconds has samples at 0, 30 and 60, plus its true final balances in the side summaries. It has no 90/300-second sample. Do not interpret its final treasury as a five-minute result. Refresh does not reset the ledger. Logs are in memory until emitted; a process crash/redeploy still loses an unfinished match's history. The diagnostic contains no reconnect tokens or nicknames.

## Hosting notes
The hosted setup uses a public ChatGPT Sites frontend and one Render Web Service for the game server. Render runs the persistent Node.js/Express process, Socket.IO WebSockets, and authoritative 30 Hz in-memory game loop. Sites serves only static browser assets. Locally, the Node server can still serve both the page and the game from one origin.

ChatGPT Sites supports WebSockets and runs server code on Cloudflare Workers, but does not run this existing persistent Node server unchanged. Netlify Functions also require a different server design. This setup keeps the simulation and room authority on Render; the Sites page connects directly to it over secure WebSockets.

Use one instance: rooms and reconnect reservations live in that process's memory. A restart, redeploy, or free-instance sleep loses them. Reconnect restores a player only while the original room exists and the 120-second window has not expired.

## Client connection and origin configuration
- The only runtime backend URL is `window.CoreDefenseClientConfig.serverUrl` in `client-config.js`. The source `public/client-config.js` uses an empty string for same-origin local development. `npm run build:frontend` generates `dist/client-config.js` from `GAME_SERVER_URL`; it does not change the local config or game code.
- `npm ci` and `npm start` still work locally at http://localhost:3000. The default development allowlist is that origin and http://127.0.0.1:3000 (or the configured PORT). For other frontend ports, set ALLOWED_ORIGINS explicitly.
- The browser uses Socket.IO over WebSockets directly, without cookies or HTTP polling fallback. Browsers include the page's Origin in the WebSocket handshake, including same-origin local use.
- The static Socket.IO client (version 4.8.1), its source map and MIT license are checked into `public/vendor/`. No page loads `/socket.io/socket.io.js`. To regenerate the assets after intentionally changing the client dependency, run `npm ci` and `npm run vendor:socketio`, then commit the generated assets.
- `ALLOWED_ORIGINS` is a comma-separated list of exact frontend origins, including scheme and port. Production startup requires it. HTTPS is required except for localhost/loopback development origins. Wildcards, paths, userinfo and query strings are rejected.
- The server applies the allowlist to Socket.IO CORS, initial WebSocket handshakes, and requests/upgrades with existing session IDs. Unlisted, missing and `null` origins are rejected. `/health` remains public for Render's health checks. Origin checks do not replace player-token authorization.

## Deploy order: Render first, Sites second
The source is prepared for split deployment. Live publication and signed-out browser verification still require the real Render and Sites URLs.

1. Create an empty GitHub repository named core-defense. In the extracted project folder, run:
   ```sh
   git init
   git add .
   git commit -m "Implement Core Defense milestone 5"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/core-defense.git
   git push -u origin main
   ```
   Replace YOUR_USERNAME. If this is already a Git checkout, use its existing remote/branch instead. The included .gitignore excludes node_modules and local environment files.
2. At https://dashboard.render.com choose **New → Web Service**. Connect GitHub and select that repository.
3. Enter these settings:
   - Name: core-defense (or an available variation)
   - Branch: main
   - Region: closest to your players
   - Root Directory: blank when package.json is at the repository root
   - Language: Node
   - Build Command: `npm ci --omit=dev`
   - Start Command: `npm start`
   - Instance: Free for the demo, one instance
4. Under Advanced, set Health Check Path to `/health`. Set environment variables `NODE_ENV=production` and `NODE_VERSION=24`. Leave PORT to Render.
5. Also set `ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000` for the initial deployment. This allows local testing without temporarily opening the server to every website.
6. Click **Create Web Service**, wait for Live, and copy the actual HTTPS Render URL. Append `/health`; it must return `ok`. Do not use Render's own game page as the hosted frontend: its origin is intentionally not allowed in this split setup.
7. Build the static frontend with the real Render origin. In PowerShell (replace the example URL):
   ```powershell
   $env:GAME_SERVER_URL = "https://YOUR-SERVICE.onrender.com"
   npm run build:frontend
   ```
   On macOS/Linux:
   ```sh
   GAME_SERVER_URL=https://YOUR-SERVICE.onrender.com npm run build:frontend
   ```
   This produces `dist/` containing the page, styles, game client, shared configuration and bundled Socket.IO. The build refuses to run without a valid explicit server URL. `GAME_SERVER_URL` is a frontend build value, not a secret or a required Render environment variable.
8. Publish `dist/` through @Sites as a static Site and set its audience to **Public / anyone with the link**. Workspace policy must permit public access. Do not configure mandatory ChatGPT sign-in: room codes and reconnect tokens identify players. Record the literal deployed Sites URL. Until the next step, the page can load but its game connection will be rejected.
9. In Render's **Environment** settings, replace ALLOWED_ORIGINS with the real Sites origin plus the local origins:
   ```text
   ALLOWED_ORIGINS=https://YOUR-ACTUAL-SITES-HOST,http://localhost:3000,http://127.0.0.1:3000
   ```
   Use only scheme + hostname + optional port, with no path or query. Save the environment change and redeploy/restart the service so the new allowlist takes effect. This restart clears any existing in-memory rooms. Keep exactly one Render instance.
10. Wait for Render to be Live, then hard-refresh the Sites page and perform the tests below. A Sites URL or backend URL shown as an example above is a placeholder, not a deployed service.

### Build and Node version check
The production build command remains `npm ci --omit=dev`. The Socket.IO browser bundle is a checked-in static asset, so Render does not need the development-only `socket.io-client` package to serve it. Set NODE_ENV, NODE_VERSION and ALLOWED_ORIGINS as described above before starting the production server.

Both `package.json` and the root entry in `package-lock.json` declare `engines.node` as `>=22 <25`. Render's `NODE_VERSION=24` selects Node 24.x within that range. These settings are compatible; no package or lockfile change is needed. Commit both files. Automated tests need development dependencies and should be run locally with `npm ci` followed by `npm test`, not as the production start command.

### Test the public URL on two devices
1. Wait for Render to show Live. Open the Render HTTPS URL with `/health` appended on both devices; expect `ok`.
2. On your phone, turn Wi-Fi OFF, leave cellular data ON, and use landscape orientation. Open the actual **Sites** base URL in a private browser session not signed into ChatGPT. It must show the game lobby without a sign-in or permission wall. Enter a nickname and create a room. The phone should be Spawner and host.
3. On your computer using Wi-Fi or Ethernet, open that same **Sites** base URL in an incognito window not signed into ChatGPT. Enter a different nickname and join with the room code. The computer should be Defender. Both screens should list exactly two players.
4. Start the match from the phone. Both screens show the 10-second countdown with frozen money/time. During play, the phone says Attack the Core and offers enemy controls (Runner selected); the computer says Defend the Core and has no Runner controls.
5. On the computer, select the top ring point and confirm a Shooter for 50. Both screens show it and the same spend feed entry. Tap top gate 1 on the phone: expect cost 20, cooldown 1.5 seconds, a 2-second warning, and then a Runner. The Shooter kills it in two hits before the Core, paying 6 into the shared treasury. Then use the unguarded bottom gate to check a Core hit. Small display delays from cellular latency are normal.
6. While the match is active, refresh the phone's current page, keeping its player-specific URL and browser storage. Within the 120-second reconnect window it should restore the same player ID, nickname, Spawner role and action controls. Money, cooldown, Core HP and time continue; the roster stays at two. Host ownership can transfer to the connected computer and stays there after the phone returns.
7. Refresh the computer's current page too. It should restore the Defender identity, Defender heading, owned towers, shared treasury and placement controls, with no Runner controls. Avoid refreshing during the countdown for this test: a countdown disconnect deliberately returns the room to the lobby.
8. If desktop browser developer tools are available, inspect Network -> WS: the connection should target the Render host and upgrade with status 101. The document and `/vendor/socket.io.min.js` should come from Sites. No third-party cookies are required.
9. Keep the private windows open during refresh tests. Closing all private windows clears their storage. Successful access in signed-out sessions on both networks confirms public access for the tested Sites URL; that cannot be claimed before the actual deployment is checked.

### Where reconnect identity lives
The page stores JSON `{code, playerId, reconnectToken}` under `core-defense.player.<playerId>` in **localStorage on the page's origin**. In production that is the Sites origin, not the Render origin. The page URL contains room and player query parameters; it never contains the secret token. The client sends the token to the configured Render server in the `resume-room` Socket.IO message over WSS. No ChatGPT login, Render cookie or cross-site cookie is used.

A normal refresh of the same URL on the same browser origin retains identity. Recovery fails if storage is blocked/cleared, all incognito windows are closed, you use a different device/browser/profile/origin, or the player/room query parameters are removed. Tokens do not automatically migrate between localhost, Render and Sites. Even when the token remains stored, the server cannot reclaim a slot after the 120-second deadline or after room expiry, restart, redeploy or sleep. A frontend-only redeploy at the same origin does not itself erase localStorage. Opening the same player URL in another tab of the same browser can take over that player's connection rather than create a new player.

### Test a sleeping free instance
Close all game tabs and leave Render without inbound requests or WebSocket traffic for more than 15 minutes. The Sites page can still load while Render sleeps; it may show a connection/retry error until the backend wakes. Open the Render `/health` URL to wake it (normally about a minute), wait for `ok`, then refresh the Sites base URL and create a new room. Old rooms and reconnect reservations were in memory and cannot survive sleep/restart. An active page's keep-alive helps while a demo is running, but a suspended phone page cannot guarantee it.

References (checked October 26, 2026):
- https://render.com/docs/deploy-node-express-app
- https://render.com/docs/web-services
- https://render.com/docs/health-checks
- https://render.com/docs/node-version
- https://render.com/docs/free
- https://render.com/docs/websocket
- https://docs.netlify.com/build/functions/overview/

## Verification

Fresh verification: all 82 automated tests pass, including engine ledger accounting, exact 30-second sampling, early endings, optional upkeep, per-hit money versus score, simulator replay parity, opposite gates, paired seeds, unchanged config, network log output and client upkeep labels. Existing combat, capacity, placement, ownership, selling, reconnect and origin tests remain included.

Replaying the same accepted actions through the previous milestone and this patch with default settings produced identical gameplay snapshots at 30-second boundaries and match end for N=1, 3 and 7. The only new snapshot field is the authoritative per-tower upkeep bill. Across all 2,250 experimental runs, both sides' ledgers reconcile; the raw report retains source hashes.

Package and lockfile use version 0.5.1 with unchanged dependencies and Node engine range. No deployment or milestone 6 work was done. No live default was tuned.

Browser layout/touch testing was not performed here; the one-line upkeep HUD change is covered by client regression tests. The normal/incognito and existing phone workflow remain the manual checks. Live Sites/Render publication remains pending deployment.
