# Core Defense — milestone 2
This version includes rooms, stable player identities, reconnect, automatic roles, a host countdown, and the server-authoritative Runner loop. Towers, selling, Repair, Surge, scores and rematches are later milestones. Balance values remain provisional.

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
1. Window A: open the base URL, enter a nickname, create a room. It shows Spawner and host.
2. Window B: open the BASE URL separately (do not duplicate A's player URL), enter a second nickname, join the room code. It shows Defender. Both show the same roster and map.
3. Window A: click Start match. Both show a 10-second countdown; money and the five-minute match timer remain frozen during it.
4. When playing, click top gate 1 (or gate button 1) in A. The server immediately charges 20; the global Runner cooldown is 1.5 seconds. Both clients show a Runner warning for 2 seconds, then a pink Runner traveling straight toward the Core at 120 logical pixels/second.
5. About 5.1 seconds after the accepted click, that Runner reaches the Core center, disappears, and Core HP changes from 100 to 97. The Spawner gains 5 money. Passive income is 4.5/sec with one Defender.
6. Click another gate during cooldown: no additional purchase occurs. Runner controls are shown only to the Spawner; the server also rejects forged Defender spawn requests.
7. Refresh A during play. The same player ID, nickname, role, money, cooldown and match state return; there is no duplicate player. Refresh B too. Each window has its own player ID in the URL and its token in localStorage. Host transfers to a connected player when the current host disconnects; reconnecting does not steal host rights back.
8. For a visible offline test, disconnect one window's network briefly, then restore it within 120 seconds. The other window shows that player as reconnecting. After 120 seconds, the reservation/token expires. The match continues during a playing-phase disconnect.
9. A disconnect during countdown returns the room to the lobby so the host can restart when both sides are connected. New arrivals during countdown/play are spectators and cannot change N.
10. To test a fresh match after the simple finished status, open the base URL and create another room. Play Again is a later milestone.

Browser storage must be allowed for refresh recovery. Use the same origin consistently (localhost and 127.0.0.1 have different storage). A copied player URL without its local token cannot reclaim that player.

## Role messaging fix
- Active headings now say **Attack the Core** for the Spawner, **Defend the Core** for Defenders, and **Watching the match** for spectators. Previously everyone saw the Defender heading.
- Spectators receive viewing guidance instead of Defender instructions. Lobby guidance follows host ownership; countdown hints follow the player's role.
- Runner controls and purchase status appear only for the Spawner. The status no longer says Ready in the lobby, countdown, finished match, while disconnected, or without enough money.
- Refresh/reconnect shows connection recovery guidance until identity confirmation. Expired rooms and sessions opened elsewhere replace stale action hints and disable controls immediately.
- Core HP, timer, explicitly labeled Spawner money, gate warnings, player roster, and server-provided match result are shared information and remain visible to everyone.

To retest, create a room in a normal window and join in incognito. Start the match and compare the headings and hints; refresh each window during play and verify the role-specific text returns. A third window joining mid-match should show Spectator, Watching the match, and no Runner controls. Role selection is still automatic in this milestone; each snapshot updates the UI from the current server-assigned role.

## Scope and configuration
- `shared/config.js` supplies the map dimensions, Core position, ring, all 16 snap points, all 8 gates, reconnect window, game timings, Runner/economy numbers, rates, and rendering dimensions.
- The server and `balance_sim.js` require it; the browser loads the same file at /shared/config.js.
- Simulation: 30 fixed ticks/sec. Periodic full snapshots: 15/sec, plus immediate lobby/connection updates. Rendering interpolates with a 100ms buffer, freezing on gaps rather than predicting outcomes.
- Spawn attempts are limited to 4/sec/player (including rejected attempts); ordinary requests are limited to 10/sec/connection. Spawn limits survive reconnect.
- Money is charged and cooldown starts when the server accepts the click. A warning reserves an enemy slot; pending plus active enemies cannot exceed 80.
- Health endpoint: /health. Server binds 0.0.0.0 and process.env.PORT.
- Nicknames are rendered with textContent. Reconnect tokens never appear in shared snapshots.
- Player markers and move-preview have been removed.
- `balance_sim_v1.js` was renamed to `balance_sim.js`. Tower-killed Swarms now award the parent's 18 bounty and split; automatic splits still do not pay the parent bounty. The balance grid was not rerun or tuned.

## Hosting notes
Render was chosen because this game needs a persistent Node.js process running Express, Socket.IO WebSockets, and an authoritative 30 Hz in-memory game loop. One Render Web Service serves both the browser client and the game server.

ChatGPT Sites runs server code on Cloudflare Workers. Netlify Functions handle requests/events in ephemeral runtimes, returning responses for web requests. Neither runs this persistent Node/Socket.IO architecture unchanged. Cloudflare supports WebSockets, but adapting room coordination and the simulation lifecycle would require a different server design. This project keeps its existing server architecture on Render.

Use one instance: rooms and reconnect reservations live in that process's memory. A restart, redeploy, or free-instance sleep loses them. Reconnect restores a player only while the original room exists and the 120-second window has not expired.

## Render deployment
Deployment is manual; this project has not been published by the assistant.

1. Create an empty GitHub repository named core-defense. In the extracted project folder, run:
   ```sh
   git init
   git add .
   git commit -m "Implement Core Defense milestone 2"
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
5. Click **Create Web Service**. Wait for the deployment to become Live.
6. Open the HTTPS URL Render supplies. Open its /health path: it should return `ok`. Create a room, then join that same URL from another device/network with the room code.
7. Socket.IO uses the same origin as the page; there is no second client deployment, hardcoded localhost URL, or WebSocket port to configure.
8. Keep this deployment at one instance. Room state is in memory: restarts, redeploys and free-instance sleep lose rooms and tokens. A reconnect token restores a disconnected client only while the original server process and reservation survive.
9. Before a demo, open the URL a minute or two early. Free services idle after 15 minutes without inbound traffic and can take roughly a minute to wake. Connected clients send a 30-second keep-alive while the page is running. This is not an uptime guarantee, especially when phones suspend the page.

### Build and Node version check
Verified on Node 24.22.1 with npm 11.9.0 in a clean temporary copy: `NODE_ENV=production` and the exact build command `npm ci --omit=dev` successfully install from the included version-3 lockfile without modifying it. `npm start` then serves `/health` (`ok`), the game page, shared config, and the Socket.IO browser client. The development-only `socket.io-client` package is omitted as expected; the server serves the browser bundle from its production `socket.io` dependency.

Both `package.json` and the root entry in `package-lock.json` declare `engines.node` as `>=22 <25`. Render's `NODE_VERSION=24` selects Node 24.x within that range. These settings are compatible; no package or lockfile change is needed. Commit both files. Automated tests need development dependencies and should be run locally with `npm ci` followed by `npm test`, not as the production start command.

### Test the public URL on two devices
1. Wait for Render to show Live. Open the public HTTPS URL with `/health` appended on both devices; expect `ok`.
2. On your phone, turn Wi-Fi OFF, leave cellular data ON, and use landscape orientation. Open the base public URL (without player/room query parameters), enter a nickname, and create a room. The phone should be Spawner and host.
3. On your computer using Wi-Fi or Ethernet, open the same base public URL, enter a different nickname, and join with the room code. The computer should be Defender. Both screens should list exactly two players.
4. Start the match from the phone. Both screens show the 10-second countdown with frozen money/time. During play, the phone says Attack the Core and offers Runner controls; the computer says Defend the Core and has no Runner controls.
5. Tap top gate 1 on the phone. Expect an immediate cost of 20, a 1.5-second cooldown, a 2-second warning on both devices, and then the same Runner moving toward the Core. With no other spawns, Core HP drops from 100 to 97 roughly 5.1 seconds after the accepted spawn; the Runner disappears on both screens. Small display delays from cellular latency are normal. Towers are not part of milestone 2.
6. While the match is active, refresh the phone's current page, keeping its player-specific URL and browser storage. Within the 120-second reconnect window it should restore the same player ID, nickname, Spawner role and action controls. Money, cooldown, Core HP and time continue; the roster stays at two. Host ownership can transfer to the connected computer and stays there after the phone returns.
7. Refresh the computer's current page too. It should restore the Defender identity, Defender heading and no Runner controls. Avoid refreshing during the countdown for this test: a countdown disconnect deliberately returns the room to the lobby.

### Test a sleeping free instance
Close all game tabs and leave the service without inbound requests or WebSocket traffic for more than 15 minutes. When you reopen the public URL, Render may display a loading page while it starts the service; this normally takes about a minute. Wait for `/health` to return `ok`, then open the base game URL. If an old player URL cannot reconnect, create a new room and have the other device join its new code. The old room, match and reconnect reservation were in memory and cannot survive the sleep/restart. The 120-second reconnect window does not restore a restarted server's memory. An active page's keep-alive helps while a demo is running, but a suspended phone page cannot guarantee it.

References (checked October 26, 2026):
- https://render.com/docs/deploy-node-express-app
- https://render.com/docs/web-services
- https://render.com/docs/health-checks
- https://render.com/docs/node-version
- https://render.com/docs/free
- https://render.com/docs/websocket
- https://docs.netlify.com/build/functions/overview/

## Verification
`npm test` covers countdown/income boundaries, all eight approach paths, exact warning/cooldown timing, Core collisions, role/cost/cap validation, fixed N, timer/Core tie ordering, two-client state agreement, authenticated reconnect, host transfer, spectator joining, rate limits, reconnect expiry and snapshot cadence. Client regression tests execute the shipped client against test DOM/transport boundaries to check role/phase changes, controls, refresh/reconnect ordering and expired/moved sessions. These checks do not verify browser layout; use the manual window tests above for visual confirmation.
