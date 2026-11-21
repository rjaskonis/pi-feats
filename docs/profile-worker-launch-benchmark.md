# Profile worker launch benchmark

`tests/profile-worker-launch-benchmark.test.ts` compares the production direct launcher with the legacy Pi CLI launcher. Both use the installed Pi SDK, the same resident worker runtime and fingerprint, and the same localhost model fixture. The named profile runs under Nono in both arms. No installed API or upstream provider is needed.

```sh
PI_OPENAI_TEST_CLI=/absolute/path/to/pi \
PI_OPENAI_TEST_LAUNCH_BENCHMARK=1 \
node --experimental-strip-types --test tests/profile-worker-launch-benchmark.test.ts
```

Use Node 22 and make `nono` available on `PATH`. The test uses temporary profiles under the home cache, alternates launch order, and reports individual measurements and medians. It makes one cold and one warm request per arm, profile and round (40 requests by default; set `PI_OPENAI_TEST_LAUNCH_ROUNDS` to select 1–10 rounds). Set `PI_OPENAI_TEST_LAUNCH_SHIPPED=1` to load all shipped extensions. `PI_OPENAI_TEST_EXTERNAL_EXTENSIONS` may contain a JSON array of absolute local extension entrypoints; `PI_OPENAI_TEST_RUNTIME_NPM_DIR` can point to the shared npm runtime exposed to Nono read-only. The test asserts job isolation and launch behavior, not machine-dependent latency thresholds. It checks profile environment, workspace access, denial of adjacent-profile reads under Nono, extension state reset, and worker reuse. PSS is measured for the launcher plus descendants where Linux permits reading the entire tree; inaccessible samples are omitted.

## Boot phases and sampled memory: Pi 1.5.2 on Linux

Three rounds with the minimal extension set and a localhost model. Times are medians through the cold worker's first request. The RSS columns sum the resident sizes of the launcher and its descendants; they may count shared pages multiple times. Boot RSS is the largest observed sample in each launch (50 ms sampling before `ready`), not a guaranteed maximum. Warm RSS is sampled after the second request. Full-tree PSS was not available for Nono.

| Profile | CLI → direct cold `ready` | Direct SDK import | Direct Node start to first job | CLI → direct boot RSS | CLI → direct warm RSS |
|---|---:|---:|---:|---:|---:|
| Default fixture | 3,172 → 1,990 ms | 1,286 ms | 1,455 ms | 289 → 155 MiB | 294 → 161 MiB |
| Named fixture (Nono) | 3,578 → 2,818 ms | 1,151 ms | 1,361 ms | 303 → 172 MiB | 309 → 175 MiB |

Direct Nono launch preparation measured 25 ms; session preparation inside that worker measured 480 ms. The median per-launch residual after subtracting launch preparation, Node startup through the first job, and agent preparation from cold `ready` was 32 ms without sandbox and 1,051 ms with Nono for direct launch. This is not a measurement of Nono in isolation: it also includes unmeasured launch overhead, scheduling, fingerprinting, and IPC. The SDK import is inside the Node-to-first-job interval, not additive. For the default fixture, warm PSS declined from 196 to 111 MiB. Neither memory figure describes the SDK process alone.

## Isolating the Nono startup cost

```sh
PI_OPENAI_TEST_NONO_LAUNCH_OVERHEAD=1 \
node --experimental-strip-types --test tests/nono-launch-overhead.test.ts
```

With Nono 0.74.0 and managed Node 22.23.2, the median time to stdout over seven launches per case was 3 ms without Nono and 54 ms with Nono for `/usr/bin/printf`, versus 38 ms and 787 ms for a Node process that only writes `ready`. The Pi SDK was not imported. A separate run put the Node delta at 931 ms, versus 749 ms in the checked-in probe run.

A separate `strace` run showed the Nono process reading 124,836,408 bytes from the Node executable in 15,239 reads, before spawning the process that applied Landlock and executed Node. This identifies a sizable pre-execution binary read, not time spent executing JavaScript or applying the Landlock rules. Do not use the timing under `strace` as the production estimate. This probe leaves the normal Nono policy and checks enabled. Any change to how the executable is read or verified belongs upstream and must preserve executable integrity checks.

## Production launcher comparison: Pi 1.5.2 on Linux

Five rounds using both production launch functions and the expanded extension set. The named fixture goes through the shared profile synchronization and Nono policy validation in both arms.

| Profile | CLI → direct cold ready | CLI → direct cold total | CLI → direct warm ready | CLI → direct PSS |
|---|---:|---:|---:|---:|
| Default fixture | 2,731 → 1,788 ms (35%) | 2,911 → 1,946 ms | 270 → 223 ms | 223 → 130 MiB |
| Named fixture (Nono) | 3,219 → 2,656 ms (17%) | 3,407 → 2,835 ms | 229 → 270 ms | unavailable |

All requests used a localhost model. Warm measurements are noisy; the launch function is not called on the warm path.

## Prototype expanded run: Pi 1.5.2 on Linux

Five rounds with the shipped extensions plus installed Computer Use, Web Access and the three Orca presentation entrypoints (filtered by the normal headless worker policy). Both arms use the same fixture settings and localhost model.

| Profile | CLI cold ready (range) | Direct cold ready (range) | CLI → direct cold total | CLI → direct warm ready |
|---|---:|---:|---:|---:|
| Default fixture | 3,158 ms (2,739–3,691) | 2,000 ms (1,831–2,252) | 3,343 → 2,211 ms | 319 → 280 ms |
| Named fixture (Nono) | 4,203 ms (3,740–4,471) | 3,127 ms (2,714–3,295) | 4,487 → 3,338 ms | 315 → 301 ms |

Cold ready improved by 37% for default and 26% for Nono. Median resident PSS for the default process tree declined from 222 to 131 MiB; Nono tree PSS was unavailable.

## Full startup with Node compile caching

Set `PI_OPENAI_TEST_LAUNCH_CACHE=1` to add two experimental arms to the direct launcher: a fresh empty cache for each repetition and a profile-local cache seeded by importing the installed SDK before timing. Each cache lives in the temporary profile's writable space. Seeding the named profile runs under the same Nono policy, with no additional grants. This doubles the default run to 80 localhost requests. The experiment measures request-to-ready, not the time or cost of prebuilding a cache. Cache contents are not guaranteed to remain identical after subsequent worker starts.

Five rounds with the expanded extension set (median milliseconds):

| Profile | CLI | Direct, no cache | Direct, empty cache | Direct, SDK cache seeded |
|---|---:|---:|---:|---:|
| Default fixture | 3,116 | 1,682 | 1,863 | 1,650 |
| Named fixture (Nono) | 3,794 | 3,538 | 3,029 | 2,617 |

Warm medians ranged from 242–315 ms. Direct Nono policy/resource/environment preparation took 18–20 ms in this fixture. For uncached direct launch, the remaining time before in-worker agent preparation was 990 ms for default and 2,495 ms under Nono; this bucket includes dispatch, process startup, SDK loading, and kernel/IPC scheduling, not just the SDK import or Nono. In-worker agent preparation medians were 691 ms and 854 ms respectively. Component medians need not sum to the median total.

The CLI-to-direct improvement was repeated in both profiles, but its size varied by run. The seeded cache produced almost no median change for default and appeared faster with Nono. The Nono ranges overlap (uncached direct: 2,246–4,054 ms; seeded: 2,108–3,178 ms), and even an empty cache appeared faster than no cache in that run. Do not attribute the full difference to caching without replication. Keep the uncached direct launcher as the first production candidate.

## Alternatives reviewed against Pi v1.5.2

- **Use Pi's `./rpc-entry` instead of `pi`:** this entry still calls `main()` with `--mode rpc`. It is not a smaller SDK or a replacement for profile preparation.
- **Reuse session services:** `createAgentSessionServices()` includes a resource loader and registers extension-provided providers. Pi's extension loader caches evaluated factories, not just compiled source. Reusing those services wholesale would change job isolation; keep sharing only the current profile runtime and rebuild sessions and extension state.
- **Use a Node compile cache:** a separate SDK-import-only trial on Node 22.23.2 measured medians of 1,062 ms without the cache and 905 ms with a populated cache (five fresh processes per arm). The initial population took 1,120 ms and produced 7.2 MiB of cache files. This is a secondary experiment, not a full launch result; test cache misses, full startup and sandbox-local storage before adoption. Do not add shared write access to Nono for this.
- **Optimize fingerprinting:** five read-only calls per installed profile measured 22–68 ms for default and 23–34 ms for `teste` on an idle local path. This is not the first place to trade away immediate invalidation for performance.
- **Ask Pi for a lean SDK entrypoint:** the public SDK barrel reexports the CLI `main` along with other APIs. A supported headless entrypoint may reduce import time, but its benefit has not been measured. Do not replace the SDK barrel with fragile deep imports for this purpose.

The API now uses the uncached direct launcher by default. Both launch paths share resource synchronization, legacy migration, environment scoping and Nono policy preparation. The resident worker lifecycle and job isolation are unchanged. Warm latency dominated by the provider path is a separate problem.

## Minimal run: Pi 1.5.2 on Linux

| Profile | CLI cold ready | Direct cold ready | CLI warm ready | Direct warm ready | CLI PSS | Direct PSS |
|---|---:|---:|---:|---:|---:|---:|
| Default fixture | 1,960 ms | 1,331 ms | 23 ms | 24 ms | 194 MiB | 113 MiB |
| Named fixture (Nono) | 2,730 ms | 2,068 ms | 20 ms | 22 ms | unavailable | unavailable |

These are medians from three rounds on one host. Cold-ready time includes direct profile preparation, including Nono policy preparation and validation. It is not model latency. The fixture uses a minimal extension set and stages current-format profile settings. These historical prototype measurements predate the shared launch implementation.
