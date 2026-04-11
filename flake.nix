{
  description = "Claude Desktop for Linux (unofficial rebuild) — stable + dev channels";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
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
              gdk-pixbuf
              glib
              gtk3
              libdrm
              libxkbcommon
              mesa
              nspr
              nss
              pango
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

              # --- DIAG: capture the builder environment on failure ----
              # Everything from here until `set +x` gets logged verbatim
              # by nix-build's builder, so the failing command is obvious
              # in --print-build-logs output.
              set -x

              echo "DIAG: src=$src"
              echo "DIAG: pwd=$(pwd)"
              ls -la "$src" || echo "DIAG: src does not exist as expected"
              file "$src" 2>/dev/null || true

              mkdir -p $out
              tar -xzf $src -C $out

              # The launcher script ships with hardcoded /usr/lib paths
              # (inherited from the RPM packaging layout). Rewrite them to
              # the store path so it finds the bundled ASAR and ELECTRON_VERSION.
              substituteInPlace $out/bin/claude-desktop \
                --replace-quiet '/usr/lib/claude-desktop/app.asar'         "$out/lib/claude-desktop/app.asar" \
                --replace-quiet '/usr/lib/claude-desktop/ELECTRON_VERSION' "$out/lib/claude-desktop/ELECTRON_VERSION"

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
              #   - PATH           → xdg-utils + bubblewrap for the launcher's
              #                      xdg-mime / bwrap invocations; also
              #                      $out/lib/electron so `command -v electron`
              #                      resolves if the symlinked candidate above
              #                      is ever invalidated by a future refactor.
              #   - LD_LIBRARY_PATH → bundled Electron's private .so files
              wrapProgram $out/bin/claude-desktop \
                --prefix PATH            : "${lib.makeBinPath [ pkgs.xdg-utils pkgs.bubblewrap ]}" \
                --prefix PATH            : "$out/lib/electron" \
                --prefix LD_LIBRARY_PATH : "$out/lib/electron"

              set +x
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

        # Debug visibility into which source path the derivation takes.
        # Resolved at eval time against the flake source tree, so its
        # value is a useful diagnostic when CI has supposedly populated
        # the in-tree tarball but `nix build` still fails.
        localTarballExists = channel:
          builtins.pathExists (./nix/tarballs + "/${channel}.tar.gz");
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

          # Diagnostic: surfaces whether CI successfully dropped the local
          # tarball into the flake tree. This never fails — it just logs.
          # Read via `nix flake check --show-trace` output or by evaluating
          # `nix eval .#__debug-local-tarball` directly.
          debug-local-tarball = pkgs.runCommand "debug-local-tarball" { } ''
            echo "stable useLocalTarball = ${if localTarballExists "stable" then "true" else "false"}"
            echo "dev    useLocalTarball = ${if localTarballExists "dev"    then "true" else "false"}"
            echo OK > $out
          '';
        };
      }
    );
}
