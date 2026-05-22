{
  # Vendored pnpm store for the workspace packages built by the flake.
  #
  # Refresh this hash whenever pnpm-lock.yaml changes:
  # 1. Temporarily set the consuming `hash = lib.fakeHash;`
  # 2. Run the relevant nix build/flake check
  # 3. Copy the expected hash printed by Nix into `hash` below
  hash = "sha256-xxOb2HBDps4whZHt9x1INdXsfbPPSV1o0udmAW72H9U=";
}
