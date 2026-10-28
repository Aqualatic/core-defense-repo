# Core Defense — economy experiment

Generated with the real `server/game.js` engine at 30 Hz. Live defaults remain `upkeep.upkeepSlope = 0` and `economy.coreHitReward = 5`. The experiments are separate overrides, not combined. No milestone 6 work is included.

2,250 simulated matches: 3 settings × 5 Spawner strategies × 3 Defender counts × 50 paired seeds. Defenders use the same spread purchase policy throughout. Results describe these scripted strategies, not human playtests.

## Defender treasury at 5:00

Each cell is the mean treasury **among matches reaching 300 seconds**, followed by the number reaching 300 out of 50. Early-ending balances are excluded. Surviving cohorts can differ across settings, so a higher surviving mean does not establish a stronger defense.

| Spawner | Setting | N=1 | N=3 | N=7 |
| --- | --- | ---: | ---: | ---: |
| runner-spam | Current (0, 5) | 742.22 (50/50) | 836.86 (50/50) | 1,100.40 (50/50) |
| runner-spam | Slope 0.125 (reward 5) | 427.08 (50/50) | 518.15 (50/50) | 750.59 (50/50) |
| runner-spam | Reward 10 (slope 0) | 744.50 (50/50) | 840.70 (50/50) | 1,100.72 (50/50) |
| swarm-rush | Current (0, 5) | 741.94 (17/50) | 816.18 (17/50) | 1,122.14 (22/50) |
| swarm-rush | Slope 0.125 (reward 5) | 435.37 (17/50) | 507.47 (17/50) | 788.90 (22/50) |
| swarm-rush | Reward 10 (slope 0) | 748.41 (17/50) | 839.12 (17/50) | 1,133.73 (22/50) |
| mixed | Current (0, 5) | 576.34 (50/50) | 654.14 (50/50) | 931.64 (50/50) |
| mixed | Slope 0.125 (reward 5) | 279.99 (50/50) | 332.05 (50/50) | 585.36 (50/50) |
| mixed | Reward 10 (slope 0) | 566.92 (50/50) | 658.02 (50/50) | 934.04 (50/50) |
| weakest-gate | Current (0, 5) | 348.94 (50/50) | 458.18 (50/50) | 730.72 (50/50) |
| weakest-gate | Slope 0.125 (reward 5) | 81.68 (50/50) | 121.47 (50/50) | 365.14 (50/50) |
| weakest-gate | Reward 10 (slope 0) | 347.07 (41/50) | 404.96 (50/50) | 657.68 (25/50) |
| human-like | Current (0, 5) | 488.24 (50/50) | 573.50 (50/50) | 799.04 (50/50) |
| human-like | Slope 0.125 (reward 5) | 192.95 (50/50) | 254.58 (50/50) | 458.79 (50/50) |
| human-like | Reward 10 (slope 0) | 411.66 (50/50) | 492.78 (50/50) | 681.79 (48/50) |

## Early endings

All early endings in this comparison are Spawner wins. These are balances at the actual end time, not estimates for 5:00. Rows with zero early endings are omitted.

| Setting | Spawner | N | Early / 50 | Mean end time (seconds) | Mean Defender treasury | Mean Spawner money |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Current (0, 5) | swarm-rush | 1 | 33 | 64.91 | 26.17 | 53.90 |
| Current (0, 5) | swarm-rush | 3 | 33 | 65.96 | 21.84 | 73.70 |
| Current (0, 5) | swarm-rush | 7 | 28 | 63.18 | 21.54 | 209.55 |
| Slope 0.125 (reward 5) | swarm-rush | 1 | 33 | 64.91 | 26.17 | 53.90 |
| Slope 0.125 (reward 5) | swarm-rush | 3 | 33 | 65.96 | 21.84 | 73.70 |
| Slope 0.125 (reward 5) | swarm-rush | 7 | 28 | 63.18 | 22.21 | 209.57 |
| Reward 10 (slope 0) | swarm-rush | 1 | 33 | 63.49 | 28.98 | 275.70 |
| Reward 10 (slope 0) | swarm-rush | 3 | 33 | 65.96 | 21.84 | 323.70 |
| Reward 10 (slope 0) | swarm-rush | 7 | 28 | 63.18 | 21.54 | 459.55 |
| Reward 10 (slope 0) | weakest-gate | 1 | 9 | 61.29 | 20.00 | 50.24 |
| Reward 10 (slope 0) | weakest-gate | 7 | 25 | 72.09 | 23.59 | 40.30 |
| Reward 10 (slope 0) | human-like | 7 | 2 | 76.45 | 11.75 | 33.38 |

## What this establishes

- Slope 0.125 reduced the final treasury of surviving defenses. It changed no paired match winners in this grid. It therefore supports a smaller surplus, not a demonstrated improvement in win-rate balance.
- Reward 10 produced additional early wins against the weakest-gate and human-like scripts. It can feed more bounty to successful defenses as well as accelerate an attack that already hits the Core.
- The Swarm-rush script still produces many early losses alongside rich surviving defenses. Reporting only the five-minute treasury would hide that split.
- No live defaults were tuned. Read the complete per-match money samples and totals in `economy-comparison.json`.

## Reproduce

From the project root:

```sh
node balance_sim.js > reports/economy-comparison.json
```

For a smaller run:

```sh
node balance_sim.js --runs=5 --spawners=human-like --settings=current --ns=1,3,7
```

`--defenders=spread,clustered,lazy` includes the old clustering stress test and six-tower strategy; this report uses spread only. Importing the simulator as a module does not execute the grid.

## Method and limits

- Seeds are `100000 + N * 10000 + runIndex * 7919`, hashed with N and strategy names, then passed to mulberry32. Experiment settings are deliberately excluded from seed generation.
- Bots make decisions at 10 Hz; every match tick, action validation, income, upkeep, movement, targeting, splitting, slow pulse, bounty, score and match end uses the live engine at 30 Hz. Bot requests also respect the existing per-player and general action rate limits.
- One scripted team controller owns and buys the towers for all N. N still controls the actual team starting treasury and Spawner income. This does not model coordination delays among seven human Defenders.
- The purchase policy buys a missing Cannon, Shooter, then Freezer when affordable; otherwise a Shooter. It does not save for a Freezer. Towers are spread in the existing fixed order. Purchases precede Repair, which is used whenever eligible after purchases.
- Runner spam picks random gates. Swarm rush repeats one seeded gate without Surge. Mixed sends Tanks at the seeded gate and Runners at the geometrically opposite gate. Human-like repeats its previous gate with 65% probability, otherwise picks randomly. Weakest-gate uses perfect tower knowledge and excludes paused towers from coverage.
- There is no simulated Surge because the playable engine does not implement it yet. No extra ability or alternate combat implementation is hidden in this experiment.
- A Core destruction exactly at 300 seconds belongs to the 5:00 group and remains a Spawner win; grouping is by elapsed time, not winning side.
- All 2,250 ledgers reconcile opening balance + total credited income − total spending = final balance, within floating-point precision. Samples stop at the last elapsed 30-second boundary; early final balances live in the side summaries.
- The JSON metadata includes SHA-256 hashes of the exact engine, config and simulator used.
