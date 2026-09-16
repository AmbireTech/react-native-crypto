# @ambire/react-native-crypto

[![npm](https://img.shields.io/npm/v/@ambire/react-native-crypto)](https://www.npmjs.com/package/@ambire/react-native-crypto)

Rust implementations of six hot [viem][viem] functions, exposed to Hermes over
JSI with [uniffi-bindgen-react-native][ubrn] (ubrn).

Built for and used by the mobile wallet in [AmbireTech/extension][extension],
where these six functions cost more in Hermes than the whole rest of a portfolio
update. Moving them to Rust is what makes the mobile portfolio load at a
reasonable speed.

## Install

```sh
yarn add @ambire/react-native-crypto
cd ios && pod install
```

The npm tarball carries the compiled Rust for every Android ABI and for iOS
device and simulator, so installing needs no Rust toolchain. Only contributors
who change `rust/` need one.

Requires React Native with the New Architecture and Hermes. `viem` is a peer
dependency, pinned to the exact version the Rust was written against - see
[Parity with viem](#parity-with-viem).

## API

```ts
import {
  bytesToHex,
  checksumAddress,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  keccak256
} from '@ambire/react-native-crypto'

const calldata = encodeFunctionData(
  JSON.stringify(erc20Abi),
  'transfer',
  JSON.stringify([recipient, { $bigint: '1000000000000000000' }])
)
```

| Function | Signature | Throws |
|---|---|---|
| `bytesToHex` | `(input: ArrayBuffer) => string` | no |
| `checksumAddress` | `(address: string) => string` | on a non-address |
| `decodeFunctionResult` | `(abiJson, functionName, dataHex) => string` | `AbiError` |
| `encodeFunctionData` | `(abiJson, functionName, argsJson) => string` | `AbiError` |
| `hexToBytes` | `(input: string) => ArrayBuffer` | on malformed hex |
| `keccak256` | `(input: ArrayBuffer) => ArrayBuffer` | no |

The ABI functions take and return JSON strings rather than objects, because
crossing JSI once with a string beats crossing it repeatedly with a structured
value. Integers come back as JSON numbers up to 48 bits and as a
`{"$bigint":"<decimal>"}` tag above that, which is the widest integer Hermes
represents exactly.

## Parity with viem

These match viem's *behaviour*, quirks included, not just the spec.
`checksumAddress` recomputes a checksum rather than validating the one it is
given, and the address parser accepts exactly what viem's `isAddress` accepts.

`peerDependencies` pins the viem version the Rust was written against, because a
viem bump can change what "matching" means with nothing here failing to compile.
Treat a viem upgrade as a change that needs the parity tests re-read, not a
version bump.

Ambire's app does not import this package directly. Metro redirects viem's own
modules to shims that call these functions, so viem's internals use the native
versions too. Each shim falls back to viem when the native module is missing or
does not accept the input, so a build without the Rust part is slower but still
correct.

## Contributing

### Changing the Rust

Two separate steps, because they are needed at different times.

**The bindings** are the TypeScript and C++ that the app compiles against. They
are committed, and CI fails a PR whose bindings do not match `rust/src`:

```sh
yarn bindings:generate
```

It builds the crate for the host, has ubrn read the exported functions out of
the resulting library, writes `src/generated/` and `cpp/generated/`, then
applies the [post-generate patch](#the-post-generate-patch). Adding, removing or
changing an exported function changes the uniffi checksums; stale bindings make
`initialize()` throw at app boot rather than failing any build, so this is not
optional. Commit the result with your Rust change.

**The binaries** are the compiled Rust. They are gitignored and the release
workflow rebuilds them on a tag, so you only need this to test a change on a
device:

```sh
# Android, needs cargo-ndk and the Android NDK
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  x86_64-linux-android i686-linux-android
cargo install cargo-ndk
yarn binaries:android

# iOS, needs macOS and Xcode
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
yarn binaries:ios
```

The target lists match `ubrn.config.yaml`, which covers every Android ABI React
Native builds for and both iOS device and simulator architectures. Dropping one
fails nothing at build time. The module then throws on load on those devices,
and a consumer that catches that - as Ambire's app does - just runs slower with
no other sign.

Both scripts build the `release` profile. In the `dev` profile the crate ends up
slower than the JavaScript it replaces, with nothing in the logs to say so.

Neither script regenerates the turbo-module glue (`src/index.ts`,
`src/NativeAmbireCrypto.ts`, the Kotlin and Objective-C++ modules, the podspec).
That output does not depend on the exported function list, and regenerating it
would overwrite the hand-maintained git URL in `AmbireCrypto.podspec`. Run
`ubrn build <platform> --config ubrn.config.yaml --release --and-generate` by
hand if you ever need it back, and re-apply that URL.

### The post-generate patch

`scripts/forceNativeStringDecoder.js` rewrites one block of
`src/generated/ambire_crypto.ts` after every generate.

ubrn's template picks a global `TextDecoder` when one exists and keeps its own
C++ helper as the fallback, on the assumption that Hermes has none. In Ambire's
app one does exist, so the check passes and every string Rust returns is decoded
byte by byte on the JS thread. Profiling a portfolio reload put that at about a
second, which is more than the native call saves in the first place. The patch
forces the C++ decoder, which is compiled in unconditionally.

The script is idempotent and exits non-zero if the generated code no longer
looks like what it expects, so a ubrn upgrade breaks the build instead of
silently bringing back the slow path.

`src/generated/ambire_crypto.ts` is shared by both platforms, so an iOS generate
that skips this step also reverts Android.

`patches/uniffi-bindgen-react-native+0.31.0-3.patch` is unrelated to that
script. It adds `"./package.json"` to ubrn's own `exports` map, which ubrn needs
to resolve itself during binding generation. `yarn install` applies it through
the `prepare` script.

### Tests

`yarn rust:check` runs `cargo fmt --check`, clippy and the 67 tests in
`rust/src/tests.rs`, which is what CI runs on every PR. They cover the exported
functions including the viem parity rules that are easy to get wrong: integers
of 48 bits or fewer decode to plain JavaScript numbers and anything wider to a
BigInt tag, and `checksum_address` recomputes a checksum instead of validating
the one it is given.

The JavaScript shims are tested in the consuming app rather than here - see
`src/mobile/shims/viem/getAddress.test.ts` and
`src/mobile/services/nativeAbi/nativeAbiDecode.test.ts` in
[AmbireTech/extension][extension].

### Releasing

Bump `version` in `package.json`, merge, then push a matching `v*` tag. The
release workflow builds both platforms, checks the tag against the version and
stages the package on npm with provenance, authenticated over OIDC with no
stored token. A tag that does not match the version fails the job rather than
staging.

Staging is not publishing. The version sits on the registry unavailable to
anyone until a maintainer approves it with 2FA:

```sh
npm stage list @ambire/react-native-crypto
npm stage view <stage-id>
npm stage approve <stage-id>
```

The run summary of the release workflow lists what is waiting. `npm stage
reject <stage-id>` throws a bad build away instead. Both need npm 11.15.0 or
later.

To exercise that path without releasing, run the workflow manually from the
Actions tab and leave `stage` off. It builds both platforms, checks the
binaries are in place and uploads the packed tarball as an artifact, but stops
short of staging.

The one exception is the very first publish of a new package name. npm only
exposes the trusted-publisher form, and only accepts a staged version, on a
package that already exists, so a name has to be bootstrapped by hand once
before OIDC can take over.

## Layout

Generated by ubrn, do not edit:

- `cpp/` C++ bindings and the JSI installer
- `src/generated/` TypeScript bindings
- `src/index.ts` package entry
- `src/NativeAmbireCrypto.ts` turbo-module spec
- `android/CMakeLists.txt`
- `android/cpp-adapter.cpp`
- `android/build.gradle` also carries the ABI list from `ubrn.config.yaml`
- `android/src/main/` manifests, Kotlin module and package
- `ios/` Objective-C++ turbo-module
- `AmbireCrypto.podspec` the git URL and tag in it are hand-maintained

`yarn ubrn:clean` removes most of these before a full regenerate. It
deliberately leaves `android/build.gradle`, `AmbireCrypto.podspec` and the
Android manifests alone, because `bindings:generate` does not rewrite them.

Written by hand:

- `rust/src/lib.rs` the implementation
- `rust/src/tests.rs` the test suite
- `ubrn.config.yaml` build configuration
- `scripts/` the post-generate patch
- `android/proguard-rules.pro` see the comment in the file

Build output, gitignored and rebuilt by CI:

- `android/src/main/jniLibs/` one shared library per ABI
- `AmbireCryptoFramework.xcframework/`

To change the ABI or architecture list, edit `ubrn.config.yaml`, not
`android/build.gradle`. The generated gradle file takes its `ndk.abiFilters`
from the config, so an edit there is overwritten by the next build.

React Native Codegen output is not committed. Gradle regenerates it into
`android/build/generated/source/codegen`, which is also the only way the spec
ends up in the `com.ambirecrypto` package the Kotlin module expects. The script
that produces shippable codegen hardcodes `com.facebook.fbreact.specs` instead.
`codegenConfig.outputDir` in `package.json` points both platforms at the right
place.

## License

MIT. See [LICENSE](./LICENSE).

[ubrn]: https://jhugman.github.io/uniffi-bindgen-react-native/
[viem]: https://viem.sh
[extension]: https://github.com/AmbireTech/extension
