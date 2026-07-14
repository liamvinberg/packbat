# Packbat

Every agent session, kept.

Packbat preserves every AI coding agent session as a raw, append-only archive in a store you own, before retention timers silently delete it.

- **Raw, not derivative.** Archives are the original session files, compressed, not markdown exports. Put a file back and your harness resumes it, even years later.
- **Turnkey.** `packbat init` detects your harnesses and schedules the sync. After that you do nothing.
- **Yours.** Local-first, with an optional encrypted copy to a remote you own. No account, no server, no telemetry.

## Install

```sh
npm install --global packbat
packbat init
```

Packbat requires Node.js 22.16 or newer.

## Links

- [Website](https://packbat.dev)
- [Source](https://github.com/liamvinberg/packbat)
- [Issues](https://github.com/liamvinberg/packbat/issues)

## License

[MIT](LICENSE)
