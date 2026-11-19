{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {inherit system;};
        nodejs = pkgs.nodejs-slim_24;
        pnpm = pkgs.pnpm.override {nodejs-slim = nodejs;};
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
