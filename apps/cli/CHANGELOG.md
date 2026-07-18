# Changelog

## [0.5.0](https://github.com/liamvinberg/packbat/compare/v0.4.0...v0.5.0) (2026-07-18)


### Features

* add SQL scan to repair paste artifacts and improve error hints ([de6ab91](https://github.com/liamvinberg/packbat/commit/de6ab91400df75dd592419a23aec2135187a1239))


### Bug fixes

* mirror skip classes and rate limit backoff ([a7a0f36](https://github.com/liamvinberg/packbat/commit/a7a0f3612b46d1964ff8ff19ce03cf4fae28b380))

## [0.4.0](https://github.com/liamvinberg/packbat/compare/v0.3.2...v0.4.0) (2026-07-18)


### Features

* concurrent resumable cloud backfill ([246a2c8](https://github.com/liamvinberg/packbat/commit/246a2c8049c9a71518641a96f04700443e785c75))
* off-box upload progress in sync and init ([44ae840](https://github.com/liamvinberg/packbat/commit/44ae840d12054a071fc3b505693016ade2aba183))
* retrieval verbs serve the existing index during refresh ([63626e9](https://github.com/liamvinberg/packbat/commit/63626e9f26eb31a26a6f6c43cc65169c25fd1c3c))


### Polish

* first sync expectation line in init ([f7da2c7](https://github.com/liamvinberg/packbat/commit/f7da2c7feb90cb026ed04474bc016ceb64c5f026))

## [0.3.2](https://github.com/liamvinberg/packbat/compare/v0.3.1...v0.3.2) (2026-07-18)


### Bug fixes

* interactive cli harness timeout resets on output ([73175f4](https://github.com/liamvinberg/packbat/commit/73175f4aee217c2a2f18a7376848f55a802f6654))


### Polish

* busy spinner names the sync lock holder ([16ae41b](https://github.com/liamvinberg/packbat/commit/16ae41be344818565a814d13f3df1b4740ed66e0))

## [0.3.1](https://github.com/liamvinberg/packbat/compare/v0.3.0...v0.3.1) (2026-07-18)


### Bug fixes

* init wizard recovery kit flow ([d2dc8d5](https://github.com/liamvinberg/packbat/commit/d2dc8d58d757302351f41614f8ac154fb8b66bfc))

## [0.3.0](https://github.com/liamvinberg/packbat/compare/v0.2.1...v0.3.0) (2026-07-18)


### Features

* funnel surface stubs for the retrieval wave ([172843c](https://github.com/liamvinberg/packbat/commit/172843c3e4f92df711dc7c292d07db1eeec41d1a))
* outline verb and ranged capped show ([b5e3a7b](https://github.com/liamvinberg/packbat/commit/b5e3a7b391eed03334974390da5563aeaa538e22))
* prose-default search, role and limit flags, lock wait ([b69b199](https://github.com/liamvinberg/packbat/commit/b69b19916c5114a9db51affcd3c272d598b8f571))
* query verb, read-only sql over the retrieval cache ([6aac99e](https://github.com/liamvinberg/packbat/commit/6aac99ee3307514b24d959ddcffe01f4877d4fa7))
* sessions verb, fleet-wide discovery listing ([811132d](https://github.com/liamvinberg/packbat/commit/811132d29669144bcd2202e52e8e124724a067ec))


### Polish

* shared head and cap helpers, typed cursors ([42c76e7](https://github.com/liamvinberg/packbat/commit/42c76e707fd141c9f50b10a650ef76c8453e05cd))

## [0.2.1](https://github.com/liamvinberg/packbat/compare/v0.2.0...v0.2.1) (2026-07-17)


### Bug fixes

* recovery kit test reads the package version ([c6b2326](https://github.com/liamvinberg/packbat/commit/c6b2326dca3c940658d9b3127e59c69e37c73ab9))

## [0.2.0](https://github.com/liamvinberg/packbat/compare/v0.1.0...v0.2.0) (2026-07-17)


### Features

* add cloud client version signal ([c1f5432](https://github.com/liamvinberg/packbat/commit/c1f5432b49891045706c76d27084242d5882329c))
* add cloud managed remote ([064bd9e](https://github.com/liamvinberg/packbat/commit/064bd9e8448c472c36c05bcb39aeedd9dd610600))
* add dropbox pkce client ([bcee19b](https://github.com/liamvinberg/packbat/commit/bcee19b3b1252dee1da7c7c3fbf77fb47535ebb7))
* add github device flow ([cb17f90](https://github.com/liamvinberg/packbat/commit/cb17f90bd1235ef8ab62ceef7015885b034e659e))
* add guided off-box destinations ([4d05369](https://github.com/liamvinberg/packbat/commit/4d053692091f856cf2c57ade9408fc485bbf5fe5))
* cloud list and download api for the mirror leg ([56c38bf](https://github.com/liamvinberg/packbat/commit/56c38bfbe7d5fc42ecd812c7baeb17088f8257d4))
* complete guided destination setup ([1ff4f73](https://github.com/liamvinberg/packbat/commit/1ff4f73503137a73898a7881b6aec8324164f49d))
* cross-machine restore placement and hints ([d45fdcd](https://github.com/liamvinberg/packbat/commit/d45fdcdbab838322424576882fb4ba44c0ded9b6))
* mirror leg, archives converge across machines ([a630061](https://github.com/liamvinberg/packbat/commit/a630061b3c41f0d6a89577fc6e51745e6f495a86))
* report available updates in doctor ([d3458a7](https://github.com/liamvinberg/packbat/commit/d3458a7b09749b0ba2f217a9d429b176e2b02855))
* resident identity, recovery kit becomes backup ([6402322](https://github.com/liamvinberg/packbat/commit/6402322dd081c3d9d85ae943b31ebc08de2bbcc5))
* ship archive retrieval skill ([4addb13](https://github.com/liamvinberg/packbat/commit/4addb138bf0937b27f7a4b7804fed75b21bc60d4))


### Bug fixes

* index retrieval at sync time, not first search ([316e4ce](https://github.com/liamvinberg/packbat/commit/316e4cec9d757f44fa87c735ad94a0547643312e))
* make cloud links recoverable ([0613365](https://github.com/liamvinberg/packbat/commit/06133656d68f342c31d7c067d441b798c7e1a749))
* require populated managed rclone config ([68c29b6](https://github.com/liamvinberg/packbat/commit/68c29b60b0ae09c3752ba998ad8da25153d61388))
* route mirror failures to doctor, restore opencode into absence ([0f2a4a7](https://github.com/liamvinberg/packbat/commit/0f2a4a7f9f5003a15b90fcf84ee88f3c60a36bc3))
* send the cli version header on token refresh ([b8c0c4d](https://github.com/liamvinberg/packbat/commit/b8c0c4d574af372abb4c1f9e858533bd7663d90c))
* stub the linux opener in cloud tests ([3869f05](https://github.com/liamvinberg/packbat/commit/3869f05495fd34ef26793282fb125e5c7d3ef1fe))
* widen oauth callback wait for slow runners ([b8851ee](https://github.com/liamvinberg/packbat/commit/b8851ee9400cd8c6349c3f48e808e0bd43cef033))


### Polish

* align gates line and version helper conventions ([c107234](https://github.com/liamvinberg/packbat/commit/c107234300aadffc7ed8c02a846c74d86e277250))
* extract version helper ([846ee8a](https://github.com/liamvinberg/packbat/commit/846ee8aebeac9f66ddba29d97531d650a1620773))
* settle wizard copy ([c144665](https://github.com/liamvinberg/packbat/commit/c1446657d6615d0b6a21904527a37bc17c392733))
* sort sync imports ([7f4d715](https://github.com/liamvinberg/packbat/commit/7f4d71502f8567b6ac86abe228ad036af88a7b30))
