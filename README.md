# ton-jetton-htlc

A hashed-timelock contract for TON jettons, written to settle against Freicoin's `OP_SHA256`
script. It is one half of a cross-chain atomic swap: the same 32-byte secret opens the jettons here
and the coins there, and if nobody ever shows the secret both sides come back to whoever funded
them. No bridge, no wrapped token, no federation — two independent locks that happen to share a
hash.

## What the contract does

One swap, one contract. Deploy it with the lock, fund it once, and it has exactly two exits.

- **fund** — the maker sends jettons to the contract with `forward_ton_amount` set, so the jetton
  wallet reports the deposit with `transfer_notification`. The contract accepts that notice only
  from the wallet it derived for itself, and only from the funder it was deployed for.
- **claim** (`0x636c6169`) — anyone who knows the preimage may spend, and the jettons go to the
  recipient named at deploy time. Refused once the deadline has passed.
- **refund** (`0x72656664`) — after the deadline the jettons go back to the funder.
- **rescue** (`0x72657363`) — a month past the deadline, a second attempt at the last payout. It
  exists because a payout carries a jetton transfer downstream: if that transfer dies for want of
  gas, the deal reads as settled while the money still sits in the contract's jetton wallet. If the
  payout did land, the wallet is empty and this simply fails there.

There is no owner, no upgrade path and no pause.

### Storage

```
hash(256) deadline(32) funded(1) governed(1) amount(coins) ^[master sender recipient] ^wallet_code
```

`governed` picks how the contract derives its own jetton wallet, and that bit matters more than it
looks — see below.

### Errors

| code | meaning |
|---|---|
| 101 | deposit reported by something that is not our jetton wallet |
| 102 | already funded |
| 103 | not funded |
| 104 | preimage does not match the hash |
| 105 | claim after the deadline |
| 106 | refund before the deadline (or rescue before the grace period) |
| 107 | funded by someone other than the expected sender |
| 108 | not enough TON attached to carry the payout (floor is 0.05 TON) |

## The governed-wallet trap

Two jetton wallet layouts exist in the wild. The original reference wallet stores
`balance, owner, master, ^code`. The governed one — used by USDT on TON, and by POK — stores
`status(4), balance, owner, master` and keeps no code reference. The wallet address is the hash of
that data together with the code, so a contract that guesses the layout computes a wallet address
that does not exist, and a deposit into it is unrecoverable.

This contract therefore never takes its jetton wallet on trust and never accepts it as a parameter:
it stores the jetton master plus the wallet code and derives the address itself, under whichever
layout the `governed` bit selects. `test/pok-layout.mjs` checks the derivation against POK's real
master on mainnet.

## Build and test

```
npm install
npm run deps      # fetches stdlib.fc and the reference jetton contracts from ton-blockchain
npm run build
npm test
```

- `test/lock.mjs` — the lock itself, with a stand-in for the jetton wallet: hashlock, deadline,
  gas floor, rescue window, and the refusal of deposit notices from strangers.
- `test/jetton.mjs` — the same swap against the reference jetton minter and wallet, checking that
  balances actually move.
- `test/pok-layout.mjs` — takes POK's master and wallet code off mainnet and asks the contract for
  the wallet address it would use.

## Live runs

Both halves were run for real, not simulated.

**TON testnet** — deploy a jetton, mint it, lock it, open it:
`kQDFYybe7SviXT8HVZ28y4RcqcgW30jDyHoz2ej-_8fDRZym`

**TON mainnet, real POK** — 2 000 POK locked under a hash and released by the secret:
`EQB2c86TImCLpnE0FCb98d9zhBxTr4iHhtU50kCNsA3pttG2`, total cost 0.16 TON.

**Freicoin mainnet** — 10 FRC locked under the *same* hash
(`c5c1fc4702267a84ff0fc682cc99f5a77a448abcbd729a7e8d3212bd7cd32449`) and spent with the *same*
secret: lock `72d1bb39a05c4257fa49433f53befa5a1422d2e4ad9eeb98dc12656fdc1e6254`, claim
`71ad933ae1a2d7db43dc37ee2f8fb521f42b741b67e3967dc54439135aeccead`.

The order is checkable from outside: the secret was generated for the TON run, spent the POK there
first, and only then locked the coins on Freicoin.

`scripts/testnet.mjs` and `scripts/mainnet.mjs` are those runs. They expect a `testnet-wallet.json`
holding a mnemonic — a throwaway wallet, never a real one; the file is git-ignored for a reason.

## What is missing

- **A driver.** Both legs are driven by hand here. A real swap needs software that watches both
  chains, reveals the secret in time, and never lets the shorter window close first.
- **Timeout policy.** The side that reveals the secret must work against the shorter deadline. The
  numbers depend on how fast both chains confirm, and they are not chosen here.
- **An audit.** The contract was written from scratch in FunC and has never been reviewed. The live
  runs above deliberately used amounts worth less than a dollar.

## The other half

The Freicoin side needs no new code: `core/htlc.mjs` in the wallet already builds the script
(`OP_SHA256 <hash> OP_EQUALVERIFY`, with a `CHECKLOCKTIMEVERIFY` refund branch) and has been
carrying swaps against Bitcoin in production. The only thing that had to match was the hash
function, and it does: `paymentHashOf(preimage)` and `string_hash(preimage)` agree byte for byte.

## Licence

MIT. The fetched dependencies keep their own licences: `stdlib.fc` and the reference jetton
contracts belong to ton-blockchain.
