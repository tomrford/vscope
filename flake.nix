{
  inputs = {
    # Non-strict version packages come from here
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    # Utility for building this flake
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
        };
        nodejs = pkgs.nodejs_26;
        pnpm = pkgs.pnpm_11.override { inherit nodejs; };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            nodejs
            pnpm
          ];
        };
      }
    );
}
