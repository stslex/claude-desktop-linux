{
  description = "Claude Desktop for Linux (unofficial rebuild)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        claude-desktop = pkgs.stdenv.mkDerivation rec {
          pname = "claude-desktop";
          version = "0.0.0"; # overridden by CI or user

          # Fetch the pre-built release tarball from GitHub Releases.
          # To use a locally built tarball instead, override with:
          #   claude-desktop.overrideAttrs (_: { src = ./path/to/claude-desktop-x86_64-nix.tar.gz; })
          src = pkgs.fetchurl {
            url = "https://github.com/stslex/claude-desktop-linux/releases/latest/download/claude-desktop-${version}-x86_64-nix.tar.gz";
            # TODO: replace with the actual sha256 of the release tarball.
            # Run: nix-prefetch-url <url> to get the hash.
            sha256 = pkgs.lib.fakeSha256;
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

          unpackPhase = ''
            mkdir -p $out
            tar -xzf $src -C $out
          '';

          dontBuild = true;

          installPhase = ''
            # autoPatchelfHook handles ELF patching automatically.
            # Fix up the launcher to use the bundled electron.
            wrapProgram $out/bin/claude-desktop \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.xdg-utils pkgs.bubblewrap ]}
          '';

          meta = with pkgs.lib; {
            description = "Claude Desktop for Linux (unofficial rebuild)";
            homepage = "https://github.com/stslex/claude-desktop-linux";
            license = licenses.unfree;
            platforms = [ "x86_64-linux" ];
            mainProgram = "claude-desktop";
          };
        };
      in
      {
        packages = {
          default = claude-desktop;
          claude-desktop = claude-desktop;
        };
      }
    );
}
