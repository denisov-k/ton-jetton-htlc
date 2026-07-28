#!/usr/bin/env bash
# The FunC standard library and the reference jetton contracts are not published as packages;
# they are fetched from ton-blockchain and compiled alongside our source. Pinned to main because
# that is what upstream offers — check the hashes below if reproducibility matters.
set -eu
mkdir -p contracts/jetton
curl -sfL -o contracts/stdlib.fc https://raw.githubusercontent.com/ton-blockchain/ton/master/crypto/smartcont/stdlib.fc
for f in jetton-minter.fc jetton-wallet.fc jetton-utils.fc op-codes.fc params.fc; do
  curl -sfL -o "contracts/jetton/$f" "https://raw.githubusercontent.com/ton-blockchain/token-contract/main/ft/$f"
done
cp contracts/compat.fc contracts/jetton/compat.fc
sha256sum contracts/stdlib.fc contracts/jetton/*.fc
