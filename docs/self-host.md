# Self-host the openbot box

The Linux machine is the server. Every desktop app is a remote control of that
box: HTTP commands plus live SSE, with a bearer token. Closing an app does not
stop the box.

The official box image writes data at `/home/box/sand-data`. OpenBot keeps that
path and stores it in the Docker volume `openbot-self-host-data`, so it does not
share Grok Bot's volume. Self-host uses Docker host networking so `127.0.0.1` in
an API URL is this Linux machine (the same address you use outside the box).

## What the Settings form does

Fill the Server tab, then **Install**. The app uses its own SSH client (not
system `ssh` / `scp`) to copy `host-main` and `box-exec-daemon` and start the
same Docker recipe as the local VM, except the gateway is published on
`0.0.0.0` at the port you chose (default 1340) with a token. Files are written
to `$HOME/openbot-box` on that machine (the SSH user's home), not `/opt`.

The machine you install onto must already have Docker. Official install:
https://docs.docker.com/engine/install/

**Connect** saves the access URL and token on this computer (mode `0600`, next
to settings). Environment variables still win if set:

- `SAND_HOST_GATEWAY_URL`
- `SAND_HOST_GATEWAY_TOKEN`
- `SAND_HOST_GATEWAY_NETWORK_TOKEN`

Cursor cloud box lookup stays the default when those are unset and you have not
saved a self-host URL.

## Access URL

The access URL must be reachable **from this client**. The form does not invent
an IP. After a successful SSH install it can fill `http://<the-host-you-sshed-to>:<port>`.
Change that if you actually reach the box through another name, port-forward,
or VPN address.

## Networks (not shown in the app)

- Same LAN: the box’s LAN address plus the gateway port is enough.
- Different networks: the client needs a route you already have (port forward,
  VPN, or a public address). openbot does not include a tunnel vendor.
- No public IP / CGNAT: you need some path the client can open; the app will
  not create one.

TLS: optional. If you pass both certificate and key paths, they are given to
the box as `SAND_GATEWAY_TLS_CERT` and `SAND_GATEWAY_TLS_KEY`. Local files are
uploaded; otherwise the strings are used as paths on the box.

## Advanced one-liner

The same Docker install script is available under Advanced for people who want
to paste it themselves. That is not the default path.
