{
  description = "Claude Desktop for Linux (unofficial rebuild) — stable + dev channels";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        # Import nixpkgs with allowUnfree enabled.
        #
        # Claude Desktop is distributed under an unfree license
        # (meta.license = licenses.unfree below), so nixpkgs'
        # checkMeta.assertValidity refuses to realize the derivation
        # unless allowUnfree is set — `nix build .#dev` would fail
        # with an assert from lib/customisation.nix:446 (the condition
        # passed to extendDerivation by make-derivation.nix's
        # `validity.handled`), even though `nix flake check` and
        # `nix eval .#dev.version` still succeed because they don't
        # force .drvPath realization.
        #
        # This config is local to the flake's eval context — users
        # who consume the `overlays.default` against their own
        # nixpkgs still need to set `allowUnfree` in their own config
        # (documented in nix/README.md).
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        lib = pkgs.lib;

        # ---------------------------------------------------------------------
        # Channel metadata
        #
        # CI publishes two JSON files under ./nix/ that pin the latest
        # tarball for each channel:
        #
        #   nix/stable.json — populated on push to main. Points at the latest
        #                     non-prerelease GitHub Release tarball.
        #   nix/dev.json    — populated on push to dev. Points at the latest
        #                     prerelease (prerelease: true) GitHub Release
        #                     tarball.
        #
        # If either file is missing we fall back to placeholder metadata that
        # keeps `nix flake check` green but cannot build without a user
        # override. Users typically override `src` + `version` via
        # `overrideAttrs` against the release they want (see README).
        # ---------------------------------------------------------------------
        loadChannel = path: fallback:
          if builtins.pathExists path then
            builtins.fromJSON (builtins.readFile path)
          else
            fallback;

        stableMeta = loadChannel ./nix/stable.json {
          channel = "stable";
          version = "0.0.0";
          url = "https://github.com/stslex/claude-desktop-linux/releases/latest/download/claude-desktop-0.0.0-x86_64-nix.tar.gz";
          sha256 = lib.fakeSha256;
        };

        # Dev version strings MUST sort strictly lower than their stable
        # counterpart under `builtins.compareVersions`. We achieve this by
        # suffixing `-pre` — Nix treats the `pre` component as a pre-release
        # marker that sorts *below* the empty string. So e.g.
        #
        #   compareVersions "0.13.45-pre" "0.13.45" == -1
        #
        # This guarantees `nix flake update` on a stable consumer can't
        # silently pull the dev channel if both overlays are in scope —
        # resolution picks the higher version, which is always stable.
        devMeta = loadChannel ./nix/dev.json {
          channel = "dev";
          version = "0.0.0-pre";
          url = "https://github.com/stslex/claude-desktop-linux/releases/latest/download/claude-desktop-0.0.0-pre-x86_64-nix.tar.gz";
          sha256 = lib.fakeSha256;
        };

        # ---------------------------------------------------------------------
        # Package builder (shared between channels)
        #
        # Source resolution:
        #   1. If ./nix/tarballs/<channel>.tar.gz exists in the flake tree,
        #      it is used directly. This is the escape hatch CI uses during
        #      the smoke test — it drops the freshly built tarball into the
        #      flake source so we avoid `pkgs.fetchurl` with a `file://` URL
        #      (which fails inside the fixed-output sandbox because curl
        #      can't read paths outside the derivation inputs).
        #   2. Otherwise, fall back to `pkgs.fetchurl` against the channel
        #      metadata JSON — the production code path.
        # ---------------------------------------------------------------------
        mkClaudeDesktop = { channel, version, url, sha256 }:
          let
            localTarball = ./nix/tarballs + "/${channel}.tar.gz";
            useLocalTarball = builtins.pathExists localTarball;
          in
          pkgs.stdenv.mkDerivation {
            pname = if channel == "dev" then "claude-desktop-dev" else "claude-desktop";
            inherit version;

            # Fetch the pre-built release tarball from GitHub Releases.
            # To use a locally built tarball instead, override with:
            #   claude-desktop.overrideAttrs (_: { src = ./path/to/claude-desktop-x86_64-nix.tar.gz; })
            src =
              if useLocalTarball
              then localTarball
              else pkgs.fetchurl { inherit url sha256; };

            nativeBuildInputs = with pkgs; [
              autoPatchelfHook
              makeWrapper
            ];

            buildInputs = with pkgs; [
              alsa-lib
              at-spi2-atk
              at-spi2-core
              cairo
              cups
              dbus
              expat
              # Font stack — Chromium renders text via fontconfig →
              # freetype. On non-Nix distros these come from the
              # system; inside the Nix closure we have to pin them or
              # autoPatchelfHook rewrites RPATHs to a non-existent
              # /usr/lib/libfontconfig and fontconfig_init() fails
              # early in renderer startup.
              fontconfig
              freetype
              gdk-pixbuf
              glib
              gtk3
              libdrm
              # libglvnd ships the vendor-neutral libGL.so.1 /
              # libEGL.so.1 / libGLESv2.so.2 loaders. Without it
              # Chromium's GPU process can't find the system GL even
              # when --disable-gpu isn't set, and its bundled
              # swiftshader fallback also fails because it links
              # against libEGL.so (which is in
              # autoPatchelfIgnoreMissingDeps below).
              libglvnd
              # libnotify for desktop notifications (dbus org.freedesktop.Notifications)
              libnotify
              # libsecret for the OS credential-store integration
              # Electron's safeStorage API uses. Missing it makes
              # safeStorage fall back to plaintext on Linux, but
              # Chromium still dlopens libsecret-1.so.0 at startup
              # and segfaults on the bare call if the dlopen returned
              # NULL.
              libsecret
              # PulseAudio runtime. Chromium weak-dlopens libpulse.so.0
              # during audio stack init; missing it + a bad dlopen
              # handle = segfault in webrtc/audio init.
              libpulseaudio
              libxkbcommon
              mesa
              nspr
              nss
              pango
              # libsystemd is what finally got us here. Electron's
              # main process opens a DBus connection to
              # org.freedesktop.login1 (systemd-logind) during
              # session-tracking init — this is the VERBOSE1 DBus
              # GetNameOwner log line that appears right before the
              # segfault on NixOS. The binding is done through
              # libsystemd's sd-bus helpers, which Chromium dlopens
              # as libsystemd.so.0. Without systemd in buildInputs
              # autoPatchelfHook can't rewrite the RPATH, the dlopen
              # silently returns NULL, and the first sd_bus_* call
              # dereferences it → SIGSEGV with no log line after the
              # DBus call. Pinning systemd makes libsystemd.so.0
              # resolvable via the patched RPATH and (belt +
              # suspenders) via the extended LD_LIBRARY_PATH in the
              # launcher wrapper below.
              systemd
              xorg.libX11
              xorg.libXcomposite
              xorg.libXdamage
              xorg.libXext
              xorg.libXfixes
              xorg.libXrandr
              xorg.libxcb
              # Additional X extensions that Electron dlopens on startup.
              # Missing any of these causes autoPatchelfHook to fail the
              # build with a clear "could not find dependency" message.
              xorg.libXi
              xorg.libXcursor
              xorg.libXtst
              xorg.libXrender
              xorg.libXScrnSaver
            ];

            runtimeDependencies = with pkgs; [
              xdg-utils
              bash
            ];

            # Bundled Electron lives in $out/lib/electron and finds its
            # sibling .so files via $ORIGIN relative RPATH. autoPatchelfHook
            # preserves $ORIGIN entries, so no extra appendRunpaths needed.
            # LD_LIBRARY_PATH is set in the launcher wrapper below as a
            # belt-and-suspenders measure for Electron's dlopen'd helpers.
            dontUnpack = true;
            dontBuild = true;
            dontConfigure = true;
            dontPatch = true;

            # `dontUnpack = true` leaves `sourceRoot` unset, so stdenv's
            # `cd -- "${sourceRoot:-.}"` after unpackPhase defaults to the
            # builder's top-level tmpdir. Set it explicitly so downstream
            # phases don't trip over a non-existent directory.
            sourceRoot = ".";

            installPhase = ''
              runHook preInstall

              mkdir -p $out
              tar -xzf $src -C $out

              # The launcher script ships with hardcoded /usr/lib paths
              # (inherited from the RPM packaging layout). Rewrite them to
              # the store path so it finds the bundled ASAR and ELECTRON_VERSION.
              #
              # Also inject V8 `--js-flags=--no-memory-protection-keys` right
              # into the final `exec "$ELECTRON" ... "$ASAR" "$@"` line so
              # the flag is positioned *before* the ASAR argument. If we
              # pass it via `wrapProgram --add-flags` instead, the flag
              # arrives in `"$@"` and ends up *after* `$ASAR`, where
              # Electron treats it as an application argument rather than
              # a Chromium/V8 switch and the PKU SEGV still fires.
              # Using `--replace-fail` so the build breaks loudly if the
              # upstream launcher ever changes the exec line — better a
              # red CI than a silent regression back to the SEGV.
              #
              # Root cause recap: on NixOS 6.18.21, V8 14's default Intel
              # PKU-based code page protection (`pkey_mprotect` + `WRPKRU`)
              # takes a SIGSEGV (`SEGV_ACCERR` at a V8 pointer-cage
              # address) on the first jump into JIT code.
              # `--no-memory-protection-keys` tells V8 to skip PKU and
              # fall back to a simpler code-cage strategy. JIT stays
              # enabled, no perf cost vs. `--jitless`. Verified via a
              # controlled 20-second runtime test against the bundled
              # electron 40.8.5.
              substituteInPlace $out/bin/claude-desktop \
                --replace-quiet '/usr/lib/claude-desktop/app.asar'         "$out/lib/claude-desktop/app.asar" \
                --replace-quiet '/usr/lib/claude-desktop/ELECTRON_VERSION' "$out/lib/claude-desktop/ELECTRON_VERSION" \
                --replace-fail \
                  'exec "$ELECTRON" --no-sandbox "$ASAR" "$@"' \
                  'exec "$ELECTRON" --no-sandbox --js-flags=--no-memory-protection-keys "$ASAR" "$@"'

              # The launcher's first electron-lookup candidate is
              # `$(dirname "$ASAR")/electron/electron`. After substitution
              # that points at $out/lib/claude-desktop/electron/electron,
              # which doesn't exist — the bundled electron lives at
              # $out/lib/electron/electron. Create a relative symlink so
              # the first candidate resolves without having to substitute
              # the /usr/lib/electron fallbacks in the launcher script.
              mkdir -p "$out/lib/claude-desktop"
              ln -sn ../electron "$out/lib/claude-desktop/electron"

              # wrapProgram:
              #   - PATH → xdg-utils + bubblewrap for the launcher's
              #            xdg-mime / bwrap invocations; also
              #            $out/lib/electron so `command -v electron`
              #            resolves if the symlinked candidate at
              #            $out/lib/claude-desktop/electron is ever
              #            invalidated by a future refactor.
              #
              # NO `--prefix LD_LIBRARY_PATH` HERE — INTENTIONAL.
              #
              # An earlier iteration of this wrapper prefixed
              # `LD_LIBRARY_PATH` with `$out/lib/electron` plus the
              # `lib.makeLibraryPath` of `systemd / libglvnd /
              # libsecret / libpulseaudio / libnotify / fontconfig /
              # freetype` as a defensive measure under the hypothesis
              # that bundled Electron dlopens those at runtime. That
              # wrapper was correlated with a guaranteed startup
              # SIGSEGV on NixOS 6.18.21 that did NOT reproduce when
              # the underlying `.claude-desktop-wrapped` launcher
              # was invoked directly (bypassing the wrapper env
              # setup) — even with the V8 `--js-flags=--no-memory-
              # protection-keys` PKU workaround correctly injected
              # into the launcher's `exec` line via
              # `substituteInPlace`, the crash persisted as long as
              # the wrapper's `LD_LIBRARY_PATH` was in the
              # environment.
              #
              # Removing the `LD_LIBRARY_PATH` prefixes entirely is
              # the safe path:
              #
              #   1. `autoPatchelfHook` already rewrites DT_NEEDED /
              #      DT_RUNPATH on the electron binary and on every
              #      bundled .so that it can reach, so the library
              #      closure resolves through RPATH without needing
              #      `LD_LIBRARY_PATH` help. All of the entries from
              #      the previous `--prefix LD_LIBRARY_PATH` set are
              #      still in `buildInputs` above, so they're still
              #      in the closure — we just don't override the
              #      dynamic linker's search path with them at
              #      wrapper time.
              #
              #   2. Empirically, invoking the unwrapped launcher
              #      `$out/bin/.claude-desktop-wrapped` directly (no
              #      wrapper env) — which uses the same electron
              #      binary from the same store path with the same
              #      RPATH — runs past the SEGV point and reaches
              #      steady-state inside Electron's startup path.
              #      Reintroducing the wrapper's `LD_LIBRARY_PATH`
              #      overrides via `env LD_LIBRARY_PATH=...
              #      .claude-desktop-wrapped` reproduces the SEGV.
              #      That A/B is the actual smoking gun — the crash
              #      is caused by `LD_LIBRARY_PATH` overriding the
              #      RPATH-based library closure in a way that
              #      interferes with something V8 / Chromium does
              #      during main-process init. Best guess: the
              #      dynamic linker picks up a mismatched
              #      `libEGL.so` / `libGLESv2.so` / `libsecret-1.so`
              #      via the prefix, and the resulting lib graph
              #      triggers a code path that the RPATH-resolved
              #      one does not. Root cause not confirmed past
              #      that.
              #
              # If a future Electron / upstream change starts to
              # dlopen a lib that `autoPatchelfHook` can't predict
              # (and fails for it), add that lib to `buildInputs`
              # and let `autoPatchelfHook` patch it in via RPATH.
              # Do NOT re-add `--prefix LD_LIBRARY_PATH` without
              # first re-running the A/B above to confirm it
              # doesn't reintroduce the SEGV.
              wrapProgram $out/bin/claude-desktop \
                --prefix PATH : "${lib.makeBinPath [ pkgs.xdg-utils pkgs.bubblewrap ]}" \
                --prefix PATH : "$out/lib/electron"

              runHook postInstall
            '';

            # Electron ships a few libraries that reference ICU + swiftshader
            # via weak dlopen. autoPatchelfHook can't always resolve them;
            # ignore missing deps only on those files to keep the build
            # reproducible without masking real unresolved libraries.
            autoPatchelfIgnoreMissingDeps = [
              "libvk_swiftshader.so"
              "libGLESv2.so"
              "libEGL.so"
            ];

            passthru = {
              inherit channel;
            };

            meta = with lib; {
              description =
                "Claude Desktop for Linux (unofficial rebuild, ${channel} channel)";
              homepage = "https://github.com/stslex/claude-desktop-linux";
              license = licenses.unfree;
              platforms = [ "x86_64-linux" ];
              mainProgram = "claude-desktop";
            };
          };

        stable = mkClaudeDesktop {
          channel = "stable";
          inherit (stableMeta) version url sha256;
        };

        dev = mkClaudeDesktop {
          channel = "dev";
          inherit (devMeta) version url sha256;
        };

        # Computed at eval time — must be -1 for the check to pass.
        devVsStable = builtins.compareVersions devMeta.version stableMeta.version;
      in
      {
        packages = {
          default = stable;
          claude-desktop = stable;
          dev = dev;
          claude-desktop-dev = dev;
        };

        # Consumed by `nix flake check`.
        checks = {
          # Version-sort invariant: dev must sort strictly lower than stable
          # under builtins.compareVersions. See the comment on `devMeta` above.
          channel-version-order = pkgs.runCommand "channel-version-order" { } ''
            echo "stable version: ${stableMeta.version}"
            echo "dev    version: ${devMeta.version}"
            echo "compareVersions dev stable = ${toString devVsStable}"
            if [ "${toString devVsStable}" != "-1" ]; then
              echo "FAIL: dev version must sort strictly lower than stable" >&2
              echo "  stable = ${stableMeta.version}" >&2
              echo "  dev    = ${devMeta.version}" >&2
              echo "  builtins.compareVersions returned ${toString devVsStable}, expected -1" >&2
              exit 1
            fi
            echo OK > $out
          '';
        };
      }
    );
}
