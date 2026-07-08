{
  description = "pi-orchestra development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
  };

  outputs = { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkPkgs = system: import nixpkgs { inherit system; };
      devPackages = pkgs: [
        pkgs.nodejs_24
        pkgs.corepack
        pkgs.cacert
      ];
      source = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            name = baseNameOf path;
          in
          !(builtins.elem name [
            ".direnv"
            ".git"
            ".pnpm-store"
            "node_modules"
          ]);
      };
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = mkPkgs system;
        in
        {
          default = pkgs.mkShell {
            packages = devPackages pkgs;
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = mkPkgs system;
        in
        {
          ci = pkgs.stdenv.mkDerivation {
            name = "pi-orchestra-ci";
            src = source;
            nativeBuildInputs = devPackages pkgs;

            buildPhase = ''
              runHook preBuild

              export HOME="$TMPDIR/home"
              export CI=true
              export SSL_CERT_FILE="${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              export NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE"
              export GIT_SSL_CAINFO="$SSL_CERT_FILE"
              mkdir -p "$HOME"

              corepack pnpm install --frozen-lockfile
              corepack pnpm fmt:check
              corepack pnpm lint
              corepack pnpm test
              corepack pnpm pack --dry-run

              runHook postBuild
            '';

            installPhase = ''
              mkdir -p "$out"
              touch "$out/success"
            '';
          };
        });
    };
}
