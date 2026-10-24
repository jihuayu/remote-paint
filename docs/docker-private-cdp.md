# Docker server with private CDP

This is a trusted single-Agent server using the same custom Chromium Source as
Remote Paint. Direct CDP bypasses managed tool leases; do not concurrently give
another actor control through the Viewer. The image keeps the Source page clock
running while no Viewer is open, so Agent clicks, waits and animation can progress.

Download the matching `remote-paint-image-linux-arm64` or
`remote-paint-image-linux-x86_64` Actions artifact, then verify and load it:

```sh
sha256sum -c *.sha256
gzip -dc remote-paint-image-*.tar.gz | docker load
```

The image contains the custom Chromium, Rust Broker, pinned Node, Viewer,
CanvasKit and Debian runtime libraries. It does not need host npm/build tools
or another browser. Image checksums and `docker-image.json` identify the
actual image ID, CPU and source revision. Use only an artifact whose matching
container/CDP smoke checks passed.

`Download and run Docker Linux *` then downloads that uploaded artifact on a
new matching-CPU runner, checks the archive checksum and loaded image ID, starts
the downloaded server, and runs an Agent in a separate container against its
existing Source over private CDP. `delivered-image-linux-*` holds the delivery
receipt and runtime evidence. Missing images fail explicitly; a build-only run
is not proof of delivery or Agent connectivity.

Before upload, distribution staging removes TLS test keys/certificates and
local account configuration paths, then regenerates the inner and outer
checksums. Production payloads therefore omit those source-test fixtures;
run the complete development test suite from the source checkout instead.

On Linux, use `deploy/compose.example.yaml` as a starting point after checking
the architecture and that the three chosen loopback ports are unused. Use
`remote-paint:linux-x86_64` for amd64; the example selects ARM64. Use a new
Compose project/container name and preserve existing deployments. The example
uses host networking because Chromium CDP listens on loopback; it publishes no
Docker ports and the application binds all three listeners to `127.0.0.1`.
Do not forward CDP through a public reverse proxy or publish it on `0.0.0.0`.

An Agent on that Linux host connects to `http://127.0.0.1:19222` with CDP.
A remote trusted Agent can use an authenticated SSH tunnel, for example
`ssh -L 127.0.0.1:19222:127.0.0.1:19222 <verified-nas-host>`.
Viewer access additionally needs tunnels for 14176 and 14177. The private
runtime file `/tmp/remote-paint-ready.json` inside the container contains the
Viewer URL and the exact existing `sourceTargetId`. It is generated at startup,
not baked into the image or printed in container logs.

The pinned headless implementation starts the pipe and TCP handlers separately
and constructs the TCP listener on loopback; see
[Chromium a49e2e3 headless_devtools.cc](https://github.com/chromium/chromium/blob/a49e2e3d4addfd84e765b52afe230bedb81096db/headless/lib/browser/headless_devtools.cc).
This source check does not replace the matching Linux image/CDP runtime test.

Use `chromium.connectOverCDP('http://127.0.0.1:19222')` (or an equivalent CDP
client), select the existing Source page, and navigate/control that page. Do
not create an unrelated browser/page and call that the Remote Paint connection.
`tests/verify-container-cdp.mjs` verifies the exact target ID, navigation, click,
unattended RAF progress, screenshot, and Source survival after disconnect.

NAS-Lin's connection, architecture, capacity, paths and port ownership must be
verified before deployment. This document contains no assumed NAS address or
credentials, and an Actions build does not itself prove NAS deployment.
