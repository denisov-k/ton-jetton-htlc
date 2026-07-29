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

Since then the same halves have carried real POK against mainnet FRC in both directions, driven
from a phone through the swap desk below.

## The driver

`driver/` turns the contract into an actual swap between two people. Each side runs its own
commands against its own config; nothing is shared but the offer, which is a few lines of JSON.

```
initiator (gives FRC, wants jettons)      responder (gives jettons, wants FRC)
------------------------------------      ------------------------------------
offer    invents the secret, locks FRC →  accept   checks that lock, locks jettons
take     checks the jetton lock, claims → collect  reads the secret off TON, claims FRC
         them and so reveals the secret
refund   after its deadline               refund   after its deadline
```

Nothing is taken on trust. Before locking jettons the responder checks that the coins really are
on chain, in the promised amount, under its own claim key, with enough blocks left to collect
after the secret appears. Before revealing the secret the initiator checks the jetton lock the same
way — amount, hash, deadline — and that the contract sitting there is *this* code, by comparing the
code cell hash. A lookalike contract with a back door fails that test.

The deadlines are the one thing that must not be sloppy: the side that reveals the secret works
against the shorter clock, so the other side still has room to use it. `frcBlocks` and `tonSeconds`
in the config set them; `minBlocks` and `minSeconds` are the margins each side refuses to go below.

Copy `driver/config.example.json` to `driver/config.json` and fill in the node, the key, the
mnemonic file and the jetton. Then:

```
SWAP_CONFIG=driver/config.json node driver/swap.mjs offer --frc 500000000 --jettons 3000 \
    --from <their TON address> --to <our TON address>
SWAP_CONFIG=... node driver/swap.mjs accept  --file offer.json
SWAP_CONFIG=... node driver/swap.mjs take    --id <swap id>
SWAP_CONFIG=... node driver/swap.mjs collect --id <swap id>
SWAP_CONFIG=... node driver/swap.mjs status  --id <swap id>
```

A full two-party run has been done this way: 5 FRC against 3 000 jettons, Freicoin regtest against
TON testnet, two separate keys and two separate wallets, every step verified before it moved.

### Running unattended

Once both locks are up, a missed deadline is a loss, not an inconvenience: if the responder never
collects, the initiator refunds and the jettons are already gone. `driver/watch.mjs` walks every
open swap in the journal on a timer, takes the next step for each, and refunds when a deadline
arrives with nothing to show for it. It is safe to restart — everything it needs is in the journal
and on the two chains.

```
SWAP_CONFIG=driver/config.json node driver/watch.mjs [--once]
```

`deploy/fw-swap-watch@.service` runs it as a systemd unit, one instance per config:
`systemctl enable --now fw-swap-watch@main`.

Both refund paths have been exercised against live chains, not only in theory: coins returned when
nobody accepted the offer, and jettons returned when nobody took them.

### The counterparty's page

Locking jettons by hand from a wallet app is a trap: the wallet sets a token-sized
`forward_ton_amount`, the deposit notice never fires, and the money sits in limbo until rescue.
`web/lock.html` exists so the counterparty never has to know that. It takes the swap's plain
fields in the URL, recomputes the contract address in the browser — from the code cell baked in
at build time, so only this code can be deployed — shows every number it is about to commit to,
and hands the two prepared transactions (deploy + transfer) to the user's own wallet over
TON Connect. Keys stay in the wallet.

The page refuses to proceed if the connected wallet is not the one the refund path names: signing
from any other wallet would hand the timeout exit to a stranger.

`node driver/swap.mjs invite --id <swap id>` prints the link. `npm run page` rebuilds the bundle.
A live copy sits at https://freicoin.ru/swap/lock.html.

## The swap desk

`web/swap.html` (live at https://freicoin.ru/swap) is the whole thing folded into one page for a
visitor who just wants to trade: pick a direction, type an amount, connect two wallets, press one
button. The house side is `driver/botd.mjs` — a daemon that quotes a rate, holds the inventory,
and answers every swap as the counterparty. It runs as `deploy/fw-tonswap.service`.

**Jettons → FRC.** The browser invents the secret and an ephemeral claim key (they never leave
it), the visitor's own TON wallet locks the jettons, the daemon verifies that lock — amount, hash,
deadline, and that the contract is this repo's code cell — and locks FRC claimable by the
ephemeral key. The page re-verifies the daemon's lock from the raw transaction bytes (script,
value, txid) before signing the claim, waits for one confirmation so nothing is revealed against
a replaceable transaction, and pays out to the connected wallet's address. The signed claim stays
on screen: the daemon is also the broadcast path, and a server that swallowed a claim would be
holding a preimage, so the visitor can push the transaction through any node.

**FRC → jettons.** The mirror, with one twist: the coins belong to the wallet at freicoin.ru, so
the page cannot sign. It hands off to the wallet **by same-tab redirect** (popups die on mobile
Safari), passing only a swap id. The wallet fetches the terms from the daemon itself, rebuilds
the lock, and refuses unless the refund key in it is its own — a hand-crafted link can only ever
point at a real offer whose timeout pays the wallet's owner. If the light client has not finished
verifying the chain yet, the wallet funds the lock from confirmed UTXOs the daemon reports for
the wallet's own scripts — it still signs every input itself, so this borrows "which of my coins
are confirmed", never a key.

Deals survive reloads (one localStorage slot per deal — a shared slot once cost a secret when a
second deal overwrote the first), a second deal cannot start while one is running, and both
directions were proven end to end against live chains, headlessly and by hand on a phone.

## What is missing

- **An audit.** The contract was written from scratch in FunC and has never been reviewed. The
  live runs and the desk's limits deliberately keep amounts small.
- **A second market maker.** The desk is one daemon with one inventory and an operator-set rate.
  Fine for a pilot, a single point of price-setting all the same.
- **TON API keys.** Public endpoints rate-limit and occasionally lie about fresh accounts
  (exit `-13`); the daemon retries around both, but a keyed endpoint would remove the noise.

## The other half

The Freicoin side needs no new code: `core/htlc.mjs` in the wallet already builds the script
(`OP_SHA256 <hash> OP_EQUALVERIFY`, with a `CHECKLOCKTIMEVERIFY` refund branch) and has been
carrying swaps against Bitcoin in production. The only thing that had to match was the hash
function, and it does: `paymentHashOf(preimage)` and `string_hash(preimage)` agree byte for byte.

## Licence

MIT. The fetched dependencies keep their own licences: `stdlib.fc` and the reference jetton
contracts belong to ton-blockchain.
