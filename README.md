# Core Defense — milestone 3
This version adds Defender Shooter placement, automatic targeting and damage, kill bounties into one shared treasury, and a shared spend feed. It retains rooms, stable identities, reconnect, automatic roles, countdown and the server-authoritative Runner loop. Other towers/enemies, selling, upkeep, Repair, Surge, score UI and rematches are later milestones. Balance values remain provisional; no balance simulation was rerun or tuned.

## Run locally
Install Node.js 22 or 24 (Node 24 is recommended). Extract this project and open a terminal in the folder containing package.json.

```sh
npm ci
npm start
```

Open http://localhost:3000. GET http://localhost:3000/health returns plain text `ok`.
To use another port, set the PORT environment variable before starting.
Run `npm test` for deterministic game-loop and two-client Socket.IO tests.

## Two-window test
1. Stop the old server, start this version, and reload both pages. Window A: in a normal browser window, open http://localhost:3000, enter a nickname and create a room. It shows Spawner and host.
2. Window B: in incognito, open the BASE URL separately (do not copy A's player URL), enter a second nickname and join the room code. It shows Defender. Both show the same roster, map, Core HP, timer and **Shared Treasury**. Keep incognito open throughout the refresh test.
3. A: click Start match. Both show a 10-second countdown with frozen money and five-minute match timer. Confirm Placement is disabled; placement and spawning open only after the countdown.
4. B: tap/click near the point at the top of the ring (point 13, directly below gate 1). The nearest empty point highlights with its range circle. Selection alone does not spend. Click **Confirm Placement · 50**. A cyan Shooter appears for its owner, lavender on A; both see one tower, the 50-credit deduction and `YourName placed a Shooter -50` in the spend feed. Treasury starts at 150 with one Defender and grows at 5/sec, so it will already be above 100 if you take a moment to place.
5. A: click top gate 1. The server charges 20 immediately, starts its 1.5-second Runner cooldown and shows a 2-second warning to both clients. The Runner appears, approaches the Shooter, flashes a shot line and loses HP from 20 to 8. A second shot about half a second later kills it. It disappears before reaching the Core; Core HP stays 100. Both treasuries receive the same +6 bounty on top of passive income. The kill occurs about 2.83 seconds after the accepted spawn with this exact placement.
6. With no other towers placed, send a Runner from bottom gate 3. The top Shooter cannot reach that approach; the Runner disappears at the Core and HP drops to 97 about 5.1 seconds after the accepted spawn. A Core hit still pays the Spawner +5.
7. B: select other points and buy Shooters. Each costs 50 from the same treasury. Below 50, Confirm Placement is grayed out with an insufficient-funds message. Tapping an occupied point selects the nearest empty point instead. All 16 points are available regardless of Defender count. The server rejects occupied points, invalid IDs, wrong roles and insufficient funds without charging.
8. Refresh B during active play using its current URL. Expect the same Defender identity, owned cyan towers, spend feed, treasury and room; no duplicate player or second charge. Towers continue firing during a disconnect. A temporary selection is cleared, so tap a point again before the next placement. Refresh A too: Spawner identity/controls return, and both still agree. Host transfers when its current owner disconnects; reconnecting does not steal host rights back.
9. For an offline test, disconnect one window briefly, then restore it within 120 seconds. The other shows that player as reconnecting. After 120 seconds, the reservation/token expires. A countdown disconnect returns the room to the lobby; a playing-phase disconnect does not pause the match. New arrivals during countdown/play are spectators and cannot place or spawn.
10. Optional shared-spend race test: before starting a new room, join a second Defender from another browser profile. Both select the same empty point and confirm together. Exactly one purchase succeeds, one tower appears and only 50 is deducted; the other request is rejected. With two Defenders, starting treasury is 160 and team income is still 5/sec.
11. To test a fresh match after the simple finished status, open the base URL and create another room. Play Again is a later milestone.

Browser storage must be allowed for refresh recovery. Use the same origin consistently (localhost and 127.0.0.1 have different storage). A copied player URL without its local token cannot reclaim that player.

## Role messaging fix
- Active headings now say **Attack the Core** for the Spawner, **Defend the Core** for Defenders, and **Watching the match** for spectators. Previously everyone saw the Defender heading.
- Spectators receive viewing guidance instead of Defender instructions. Lobby guidance follows host ownership; countdown hints follow the player's role.
- Runner controls and purchase status appear only for the Spawner. The status no longer says Ready in the lobby, countdown, finished match, while disconnected, or without enough money.
- Refresh/reconnect shows connection recovery guidance until identity confirmation. Expired rooms and sessions opened elsewhere replace stale action hints and disable controls immediately.
- Core HP, timer, explicitly labeled Spawner money, Shared Treasury, spend feed, gate warnings, player roster, and server-provided match result are shared information and remain visible to everyone.
- Milestone 3 adds Defender-only placement controls and role/phase-aware placement hints, including countdown, affordability, pending requests and reconnect. Spawners and spectators never receive a Confirm Placement control.

To retest, create a room in a normal window and join in incognito. Start the match and compare the headings and hints; refresh each window during play and verify the role-specific text returns. A third window joining mid-match should show Spectator, Watching the match, and no Runner controls. Role selection is still automatic in this milestone; each snapshot updates the UI from the current server-assigned role.

## Scope and configuration
- `shared/config.js` supplies the map dimensions, Core position, ring, all 16 snap points, all 8 gates, reconnect window, game timings, Runner/economy numbers, rates, and rendering dimensions.
- The server and `balance_sim.js` require it; the browser loads the same file at /shared/config.js.
- Simulation: 30 fixed ticks/sec. Periodic full snapshots: 15/sec, plus immediate lobby/connection updates. Rendering interpolates with a 100ms buffer, freezing on gaps rather than predicting outcomes.
- Spawn and placement attempts each have a separate 4/sec/player limit (including rejected attempts); ordinary requests are limited to 10/sec/connection. Both player limits survive reconnect.
- Defenders select one of the 16 fixed points and confirm. The server selects the position from shared config, checks role/phase/occupancy/funds and charges the shared treasury atomically. No position, cost or ownership supplied by a client is trusted.
- Shooter: cost 50, range 120, damage 12, two shots/sec. It fires on the first eligible tick, then at its configured interval, targeting the closest-to-Core enemy among those in range. Equal distances use the lower enemy ID. Damage is instant; shot lines are visual only. Enemies still ignore towers. Tick order retains movement/Core collisions before tower fire and the match-end check.
- Shared treasury starts at 150 + 10 per extra Defender (N fixed at start), earns 5/sec during play and receives 6 per Runner kill. The killing tower retains its owner's kill and actual damage credit; overkill is not counted as extra damage. Towers keep working while the owner is offline. Upkeep and selling are not enabled in this milestone.
- The latest eight purchases appear in the shared spend feed. Nicknames remain textContent, including in this feed. New placement limits, feed size and shot visuals are in shared/config.js; gameplay numbers were not rebalanced.
- Money is charged and cooldown starts when the server accepts the click. A warning reserves an enemy slot; pending plus active enemies cannot exceed 80.
- Health endpoint: /health. Server binds 0.0.0.0 and process.env.PORT.
- Nicknames are rendered with textContent. Reconnect tokens never appear in shared snapshots.
- Player markers and move-preview have been removed.
- `balance_sim_v1.js` was renamed to `balance_sim.js`. Tower-killed Swarms now award the parent's 18 bounty and split; automatic splits still do not pay the parent bounty. The balance grid was not rerun or tuned.

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
   git commit -m "Implement Core Defense milestone 3"
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
4. Start the match from the phone. Both screens show the 10-second countdown with frozen money/time. During play, the phone says Attack the Core and offers Runner controls; the computer says Defend the Core and has no Runner controls.
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
Fresh milestone 3 verification: 34 automated tests pass. A clean production install and `npm start` smoke test also passed with two real Socket.IO clients, the automatic countdown/game loop, Shooter combat, bounty arithmetic and refresh-style reconnect. Node syntax checks pass. The package and lockfile both use version 0.3.0 with unchanged dependencies and Node engine range.

The browser executable could not be downloaded in this environment, so an actual browser layout/touch run remains a manual check. Client tests exercise DOM events and canvas drawing calls through test boundaries; they are not a substitute for the normal/incognito visual test above.

Milestone 3 adds checks for placement validation, all 16 slots, simultaneous purchases, exact-income affordability, targeting/range/fire cadence, kill bounty deduplication, ownership and combat during reconnect, plus role-specific selection/confirmation UI. The existing Plan B origin, static asset and reconnect checks remain included. Live Sites/Render publication and signed-out device testing remain pending the actual URLs.

`npm test` covers countdown/income boundaries, all eight approach paths, exact warning/cooldown timing, Core collisions, role/cost/cap validation, fixed N, timer/Core tie ordering, two-client state agreement, authenticated reconnect, host transfer, spectator joining, rate limits, reconnect expiry and snapshot cadence. Client regression tests execute the shipped client against test DOM/transport boundaries to check role/phase changes, controls, refresh/reconnect ordering and expired/moved sessions. These checks do not verify browser layout; use the manual window tests above for visual confirmation.
