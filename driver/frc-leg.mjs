// frc-leg.mjs — the Freicoin half of a swap: build the lock, fund it from a key's own coins,
// spend it with a preimage, or take it back after the timeout. Talks to a node over freicoin-cli
// and borrows the wallet's own primitives, so the script here is only glue.
import { execFileSync } from 'node:child_process';

const CORE = process.env.FREICOIN_CORE || '/root/free-money/freicoin-wallet/core';
const { serializeTx } = await import(`${CORE}/tx.mjs`);
const { pubkeyCompressed, signEcdsa } = await import(`${CORE}/ecdsa.mjs`);
const { segwitV0Sighash, SIGHASH_ALL } = await import(`${CORE}/sighash.mjs`);
const { assetPresentValue } = await import(`${CORE}/assets.mjs`);
const { frcWpkSpk } = await import(`${CORE}/freiland.mjs`);
const { encodeWitness } = await import(`${CORE}/address.mjs`);
const H = await import(`${CORE}/htlc.mjs`);

const HOST = { k: 20, interest: false };
const rev = h => h.match(/../g).reverse().join('');

export function frcNode({ bin = '/root/fcbuild-31/bin/freicoin-cli', args = [] } = {}) {
  const cli = (...a) => execFileSync(bin, [...args, ...a], { encoding: 'utf8' }).trim();
  const json = (...a) => JSON.parse(cli(...a));
  return {
    cli, json,
    tip: () => json('getblockcount'),
    // Every unspent output of `address`. Two fields matter and they are easy to confuse:
    // `value` is the nominal at the coin's own refheight — that is what a signature commits to —
    // while `amount` is the same coin discounted to the current tip. And `refheight` is the
    // transaction's lock height, which for anything but a coinbase is not the block it landed in.
    coins(address) {
      const scan = json('scantxoutset', 'start', JSON.stringify([`addr(${address})`]));
      return scan.unspents.map(u => ({
        txid: u.txid, vout: u.vout, height: u.height, refheight: u.refheight, coinbase: u.coinbase,
        nominal: BigInt(Math.round(u.value * 1e8)),
      }));
    },
    send: raw => cli('sendrawtransaction', raw),
    outAt: (txid, n) => { try { return json('gettxout', txid, String(n)); } catch { return null; } },
  };
}

/** The lock script and where to pay to reach it. `claimPub` spends with the preimage, `refundPub`
 *  after `cltv`. Both sides must agree on all four before any money moves. */
export function frcLock({ paymentHash, claimPub, refundPub, cltv, net = 'main' }) {
  const leaf = H.htlcLeaf({ paymentHash, claimPub, refundPub, cltv });
  return { leaf, spk: H.htlcSpk(leaf), address: H.htlcAddress(leaf, net), cltv, paymentHash };
}

export const frcAddress = (pub, net = 'main') => encodeWitness(net, 0, frcWpkSpk(pub).slice(4));

/** Fund a lock from one of `key`'s coins. Picks the oldest mature one that covers the amount. */
export function frcFund({ node, key, lock, amount, fee = 50000n, maturity = 100, net = 'main' }) {
  const pub = pubkeyCompressed(key);
  const mySpk = frcWpkSpk(pub);
  const h = node.tip();
  const coin = node.coins(frcAddress(pub, net))
    .filter(c => !c.coinbase || h - c.height >= maturity)      // maturity is a coinbase rule only
    .map(c => ({ ...c, pv: assetPresentValue(c.nominal, h - c.refheight, HOST) }))
    .filter(c => c.pv > amount + fee)
    .sort((a, b) => a.height - b.height)[0];
  if (!coin) throw new Error('no mature coin large enough');

  const tx = {
    version: 2, hasWitness: true, flags: 1, nLockTime: 0, lockHeight: h,
    vin: [{ prevout: { txid: rev(coin.txid), vout: coin.vout }, scriptSig: '', sequence: 0xfffffffd, witness: [] }],
    vout: [{ value: amount, scriptPubKey: lock.spk },
           { value: coin.pv - amount - fee, scriptPubKey: mySpk }],
  };
  const script = '21' + pub + 'ac';
  const sh = segwitV0Sighash(tx, 0, script, coin.nominal, coin.refheight, SIGHASH_ALL);
  tx.vin[0].witness = [signEcdsa(key, sh) + '01', '00' + script, ''];
  const raw = serializeTx(tx);
  return { rawtx: raw, txid: node.send(raw), vout: 0, refheight: h, value: amount };
}

/** Spend a funded lock with the preimage. */
export function frcClaim({ node, lock, funding, preimage, claimKey, toSpk, fee = 50000n }) {
  const built = H.htlcClaim({ prevTxid: funding.txid, vout: funding.vout, value: funding.value,
    refheight: funding.refheight, leafHex: lock.leaf, preimage, claimKey, toSpk, fee });
  return { txid: node.send(built.rawtx), rawtx: built.rawtx };
}

/** Take a funded lock back once its timeout has passed. */
export function frcRefund({ node, lock, funding, refundKey, toSpk, fee = 50000n }) {
  const built = H.htlcRefund({ prevTxid: funding.txid, vout: funding.vout, value: funding.value,
    refheight: funding.refheight, leafHex: lock.leaf, cltv: lock.cltv, refundKey, toSpk, fee });
  return { txid: node.send(built.rawtx), rawtx: built.rawtx };
}

export { frcWpkSpk, pubkeyCompressed };
