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
        # ---------------------------------------------------------------------
        mkClaudeDesktop = { channel, version, url, sha256 }:
          pkgs.stdenv.mkDerivation {
            pname = if channel == "dev" then "claude-desktop-dev" else "claude-desktop";
            inherit version;

            # Fetch the pre-built release tarball from GitHub Releases.
            # To use a locally built tarball instead, override with:
            #   claude-desktop.overrideAttrs (_: { src = ./path/to/claude-desktop-x86_64-nix.tar.gz; })
            src = pkgs.fetchurl {
              inherit url sha256;
            };

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

            installPhase = ''
              runHook preInstall

              mkdir -p $out
              tar -xzf $src -C $out

              # The launcher script ships with hardcoded /usr/lib paths
              # (inherited from the RPM packaging layout). Rewrite them to
              # the store path so it finds the bundled ASAR and Electron.
              substituteInPlace $out/bin/claude-desktop \
                --replace-quiet '/usr/lib/claude-desktop/app.asar'         "$out/lib/claude-desktop/app.asar" \
                --replace-quiet '/usr/lib/claude-desktop/ELECTRON_VERSION' "$out/lib/claude-desktop/ELECTRON_VERSION"

              # wrapProgram:
              #   - PATH           → xdg-utils + bubblewrap for the launcher's
              #                      xdg-mime / bwrap invocations
              #   - LD_LIBRARY_PATH → bundled Electron's private .so files
              wrapProgram $out/bin/claude-desktop \
                --prefix PATH            : ${lib.makeBinPath [ pkgs.xdg-utils pkgs.bubblewrap ]} \
                --prefix LD_LIBRARY_PATH : "$out/lib/electron"

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
