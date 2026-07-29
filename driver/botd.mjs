// botd.mjs — the house side of a POK→FRC swap, as an HTTP service the page talks to.
//
// The visitor gives jettons and wants coins. Their browser invents the secret and an ephemeral
// claim key; this daemon answers with money: it watches the jetton lock the visitor funds, checks
// it, locks FRC claimable by the visitor's ephemeral key, broadcasts the visitor's claim when it
// arrives (the claim reveals the secret on OUR chain), and then takes the jettons with that secret.
//
// Deadlines, as everywhere in this repo: the revealer works against the shorter clock. The visitor
// reveals (claims FRC), so OUR lock is the short one and THEIR jetton lock the long one.
//
//   quote   → { rate, min, max, tonTaker }                       what a deal would look like
//   offer   → { id, tonDeadline, master, governed, ... }         open a swap, get the lock terms
//   status  → { state, frcLock?, ... }                           poll; frcLock appears when we commit
//   claim   → { txid }                                           submit the signed FRC claim rawtx
//   refund  → advice only: the jetton refund is a wallet message the visitor sends themself
//
// State machine per swap: open → jetton-locked → frc-locked → claimed → done
//                              ↘ expired (their deadline passed unfunded)   ↘ frc-refunded
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { frcLock, frcFund, frcRefund, frcNode, frcWpkSpk, pubkeyCompressed } from './frc-leg.mjs';
import { tonClient, tonWallet, tonLock, tonState, jetton, Address, Cell } from './ton-leg.mjs';

const CFG = JSON.parse(readFileSync(process.env.BOTD_CONFIG || 'driver/botd.json', 'utf8'));
const DIR = CFG.journalDir;
mkdirSync(DIR, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sha256hex = b => createHash('sha256').update(b).digest('hex');

const KEY = readFileSync(CFG.frc.keyFile, 'utf8').trim();
const PUB = pubkeyCompressed(KEY);
const node = frcNode({ bin: CFG.frc.cli, args: CFG.frc.args });
const HTLC_CODE = Cell.fromBase64(readFileSync(CFG.ton.codeFile, 'utf8'));

const swaps = new Map();
for (const f of readdirSync(DIR)) if (f.endsWith('.json')) {
  const s = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')); swaps.set(s.id, s);
}
const store = s => { writeFileSync(`${DIR}/${s.id}.json`, JSON.stringify(s, null, 2)); swaps.set(s.id, s); return s; };

let tctx = null;
async function ton() {
  if (!tctx) {
    const client = await tonClient(CFG.ton);
    tctx = { client, wallet: await tonWallet(client, CFG.ton.mnemonicFile),
             j: await jetton(client, Address.parse(CFG.ton.jettonMaster)) };
  }
  return tctx;
}

const lockOf = s => tonLock({
  codeCell: HTLC_CODE, paymentHash: s.hash, deadline: s.tonDeadline,
  master: Address.parse(CFG.ton.jettonMaster), walletCode: tctx.j.walletCode,
  governed: CFG.ton.governed, sender: Address.parse(s.tonGiver),
  recipient: Address.parse(s.tonTaker),
});

// ---- API ---------------------------------------------------------------------------------------
const api = {
  async quote() {
    return { rate: CFG.rateFrcPerJetton, minJettons: CFG.minJettons, maxJettons: CFG.maxJettons,
      symbol: CFG.ton.symbol, decimals: CFG.ton.decimals, master: CFG.ton.jettonMaster,
      governed: CFG.ton.governed, chain: CFG.ton.chain,
      tonTaker: (await ton()).wallet.address.toString({ bounceable: false, testOnly: CFG.ton.chain === 'testnet' }) };
  },

  async offer(b) {
    const jettons = BigInt(b.jettons ?? 0);
    if (jettons < BigInt(CFG.minJettons) || jettons > BigInt(CFG.maxJettons)) throw new Error('сумма вне лимитов');
    if (!/^[0-9a-f]{64}$/.test(b.hash ?? '')) throw new Error('bad hash');
    if (!/^[0-9a-f]{66}$/.test(b.claimPub ?? '')) throw new Error('bad claimPub');
    const payout = String(b.frcPayout ?? '');
    if (!/^(fc|fcrt|tf)1[a-z0-9]{20,}$/.test(payout)) throw new Error('bad payout address');
    Address.parse(b.tonGiver);                                  // throws on garbage
    // the price is ours to quote; the amount of FRC follows from it, not from the visitor
    const frcAmount = BigInt(Math.floor(Number(jettons) * CFG.rateFrcPerJetton));
    if (frcAmount <= 100000n) throw new Error('слишком мелко');
    const t = await ton();
    const s = store({
      id: b.hash.slice(0, 16), hash: b.hash, state: 'open', createdAt: Date.now(),
      jettons: String(jettons), frcAmount: String(frcAmount),
      claimPub: b.claimPub, frcPayout: payout, tonGiver: b.tonGiver,
      tonTaker: t.wallet.address.toString(),
      tonDeadline: Math.floor(Date.now() / 1000) + CFG.tonSeconds,
    });
    log(s.id, 'offer:', s.jettons, 'jettons →', s.frcAmount, 'kria →', payout);
    return { id: s.id, tonDeadline: s.tonDeadline, tonTaker: s.tonTaker, frcAmount: s.frcAmount,
      master: CFG.ton.jettonMaster, governed: CFG.ton.governed, chain: CFG.ton.chain };
  },

  async status(b) {
    const s = swaps.get(String(b.id ?? '')); if (!s) throw new Error('no such swap');
    const { state, frcLockInfo, frcClaimTxid, frcRefunded, tonDeadline, jettons, frcAmount } = s;
    let frcConfirmations = 0;
    if (frcLockInfo) { const o = node.outAt(frcLockInfo.txid, 0); frcConfirmations = o ? o.confirmations : 0; }
    return { id: s.id, state, frcLock: frcLockInfo ?? null, frcClaimTxid: frcClaimTxid ?? null,
      frcRefunded: !!frcRefunded, tonDeadline, jettons, frcAmount, frcConfirmations,
      // the raw funding tx lets the page verify our lock byte for byte and derive its txid itself
      frcRawTx: s.frcRawTx ?? null, tip: node.tip() };
  },

  async claim(b) {
    const s = swaps.get(String(b.id ?? '')); if (!s) throw new Error('no such swap');
    if (s.state !== 'frc-locked') throw new Error('нечего забирать: состояние ' + s.state);
    const raw = String(b.rawtx ?? '');
    if (!/^[0-9a-f]{100,20000}$/.test(raw)) throw new Error('bad rawtx');
    const txid = node.send(raw);                                // the node is the real validator
    s.state = 'claimed'; s.frcClaimTxid = txid; store(s);
    log(s.id, 'FRC claim broadcast', txid);
    return { txid };
  },

  // ---- reverse direction: the visitor gives FRC and wants jettons ------------------------------
  // The visitor invents the secret and locks FRC claimable by US (short clock, since they reveal),
  // refundable to themselves. We answer by locking jettons claimable by them. They claim the
  // jettons — revealing the secret on TON — and we read it off TON to claim the FRC.
  async offerReverse(b) {
    const jettons = BigInt(b.jettons ?? 0);
    if (jettons < BigInt(CFG.minJettons) || jettons > BigInt(CFG.maxJettons)) throw new Error('сумма вне лимитов');
    if (!/^[0-9a-f]{64}$/.test(b.hash ?? '')) throw new Error('bad hash');
    if (!/^[0-9a-f]{66}$/.test(b.frcRefundPub ?? '')) throw new Error('bad frcRefundPub');
    Address.parse(b.tonRecipient);
    const frcAmount = BigInt(Math.floor(Number(jettons) * CFG.rateFrcPerJetton));
    if (frcAmount <= 100000n) throw new Error('слишком мелко');
    if (BigInt(CFG.reserveJettons ?? 0) < jettons) throw new Error('в резерве недостаточно токенов');
    // the FRC lock the visitor must fund: we claim with the secret, they refund after a short clock
    const frcCltv = node.tip() + (CFG.reverseFrcBlocks ?? 6);
    const lock = frcLock({ paymentHash: b.hash, claimPub: PUB, refundPub: b.frcRefundPub, cltv: frcCltv, net: CFG.frc.net });
    const s = store({
      id: b.hash.slice(0, 16), hash: b.hash, dir: 'reverse', state: 'awaiting-frc', createdAt: Date.now(),
      jettons: String(jettons), frcAmount: String(frcAmount),
      frcRefundPub: b.frcRefundPub, tonRecipient: b.tonRecipient,
      frcCltv, frcLockSpk: lock.spk, frcLockLeaf: lock.leaf, frcLockAddress: lock.address,
      tonDeadline: Math.floor(Date.now() / 1000) + CFG.tonSeconds,
    });
    log(s.id, 'reverse offer:', frcAmount, 'kria FRC →', jettons, 'jettons; visitor funds', lock.address);
    return { id: s.id, frcClaimPub: PUB, frcCltv, frcAddress: lock.address, frcAmount: String(frcAmount),
      tonDeadline: s.tonDeadline, master: CFG.ton.jettonMaster, governed: CFG.ton.governed,
      chain: CFG.ton.chain, tonSender: (await ton()).wallet.address.toString() };
  },

  // Everything a wallet needs to rebuild the lock itself and refuse if it does not match.
  // The wallet is told the terms, never an address to pay blindly.
  async statusReverse(b) {
    const s = swaps.get(String(b.id ?? '')); if (!s || s.dir !== 'reverse') throw new Error('no such swap');
    return { id: s.id, state: s.state, tonAddress: s.tonAddress ?? null, tonDeadline: s.tonDeadline,
      jettons: s.jettons, frcAmount: s.frcAmount, frcClaimTxid: s.frcClaimTxid ?? null, tip: node.tip(),
      hash: s.hash, frcClaimPub: PUB, frcRefundPub: s.frcRefundPub, frcCltv: s.frcCltv,
      frcAddress: s.frcLockAddress, tonRecipient: s.tonRecipient, symbol: CFG.ton.symbol,
      decimals: CFG.ton.decimals, net: CFG.frc.net };
  },
};
const WRITE = new Set(['offer', 'claim', 'offerReverse']);

// ---- the machine -------------------------------------------------------------------------------
async function tick() {
  const t = await ton();
  for (const s of [...swaps.values()]) {
    try {
      const secsLeft = s.tonDeadline - Math.floor(Date.now() / 1000);

      if (s.dir === 'reverse') { await tickReverse(s, t, secsLeft); continue; }

      if (s.state === 'open') {
        if (secsLeft <= 0) { s.state = 'expired'; store(s); continue; }
        const tl = lockOf(s);
        const st = await tonState(t.client, tl);
        if (!st.deployed || !st.funded) continue;
        // verify what actually stands there before a single kria moves
        if (st.hash !== s.hash || st.amount < BigInt(s.jettons)) { log(s.id, 'lock mismatch — ignoring'); continue; }
        const code = (await t.client.getContractState(tl.address)).code;
        if (Buffer.compare(Cell.fromBoc(code)[0].hash(), HTLC_CODE.hash()) !== 0) { log(s.id, 'alien code — ignoring'); continue; }
        if (secsLeft < CFG.minSeconds) { log(s.id, 'funded too late — will let it refund'); continue; }
        s.state = 'jetton-locked'; s.tonAddress = tl.address.toString(); store(s);
        log(s.id, 'jetton lock verified:', st.amount.toString(), 'units at', s.tonAddress);
      }

      if (s.state === 'jetton-locked') {
        const cltv = node.tip() + CFG.frcBlocks;
        const lock = frcLock({ paymentHash: s.hash, claimPub: s.claimPub, refundPub: PUB, cltv, net: CFG.frc.net });
        const funding = frcFund({ node, key: KEY, lock, amount: BigInt(s.frcAmount),
          fee: BigInt(CFG.frc.fee), net: CFG.frc.net, maturity: CFG.frc.maturity ?? 100 });
        s.state = 'frc-locked'; s.frcRawTx = funding.rawtx;
        s.frcLockInfo = { txid: funding.txid, vout: 0, value: s.frcAmount, refheight: funding.refheight,
          cltv, refundPub: PUB, address: lock.address, leaf: lock.leaf };
        store(s);
        log(s.id, 'FRC locked:', funding.txid, 'until block', cltv);
      }

      if (s.state === 'claimed') {
        // the claim carries the preimage in its witness; dig it out and take the jettons
        const spent = !node.outAt(s.frcLockInfo.txid, 0);
        if (!spent) continue;
        const preimage = preimageFromClaim(s);
        if (!preimage) { log(s.id, 'lock spent but no preimage found — inspect by hand'); s.state = 'inspect'; store(s); continue; }
        log(s.id, 'preimage recovered from our chain, taking the jettons');
        const { tonClaim } = await import('./ton-leg.mjs');
        await tonClaim(t.wallet, lockOf(s), preimage, CFG.ton.claimGas ?? '0.15');
        s.state = 'done'; s.preimage = preimage; store(s);
        log(s.id, 'done: jettons claimed');
      }

      if (s.state === 'frc-locked') {
        if (node.tip() >= s.frcLockInfo.cltv && node.outAt(s.frcLockInfo.txid, 0)) {
          log(s.id, 'no claim came — refunding our coins');
          frcRefund({ node, lock: { leaf: s.frcLockInfo.leaf, cltv: s.frcLockInfo.cltv },
            funding: { txid: s.frcLockInfo.txid, vout: 0, value: BigInt(s.frcAmount), refheight: s.frcLockInfo.refheight },
            refundKey: KEY, toSpk: frcWpkSpk(PUB), fee: BigInt(CFG.frc.fee) });
          s.state = 'frc-refunded'; s.frcRefunded = true; store(s);
        }
        // the visitor may claim without telling us: watch the lock either way
        else if (!node.outAt(s.frcLockInfo.txid, 0)) { s.state = 'claimed'; store(s); }
      }
    } catch (e) { log(s.id, 'tick error:', e.message?.slice(0, 200)); }
  }
}

// reverse: FRC in, jettons out. Mirror of the forward machine with the legs swapped.
async function tickReverse(s, t, secsLeft) {
  // 1. the visitor funds an FRC lock claimable by us; verify it, then lock jettons for them
  if (s.state === 'awaiting-frc') {
    if (node.tip() >= s.frcCltv) { s.state = 'expired'; store(s); return; }
    const funded = frcLockFunded(s);
    if (!funded) return;
    if (secsLeft < CFG.minSeconds) { log(s.id, 'FRC funded too late — leaving it to the visitor to refund'); return; }
    s.frcLockInfo = { txid: funded.txid, vout: funded.vout, value: s.frcAmount, refheight: funded.refheight,
      cltv: s.frcCltv, leaf: s.frcLockLeaf };
    // lock jettons the visitor can claim, with us as sender/refund
    const tl = tonLock({ codeCell: HTLC_CODE, paymentHash: s.hash, deadline: s.tonDeadline,
      master: Address.parse(CFG.ton.jettonMaster), walletCode: t.j.walletCode, governed: CFG.ton.governed,
      sender: t.wallet.address, recipient: Address.parse(s.tonRecipient) });
    s.tonAddress = tl.address.toString();
    if (!(await tonState(t.client, tl)).deployed) { log(s.id, 'deploying jetton lock', s.tonAddress); await (await import('./ton-leg.mjs')).tonDeploy(t.wallet, t.client, tl); }
    const mine = await t.j.walletOf(t.wallet.address);
    log(s.id, 'FRC lock verified — locking', s.jettons, 'jettons for the visitor');
    await (await import('./ton-leg.mjs')).tonFund(t.wallet, mine, tl, BigInt(s.jettons), t.wallet.address, '0.13', '0.05');
    s.state = 'jettons-locked'; store(s);
  }

  // 2. wait for the visitor to claim the jettons (which reveals the secret on TON), then take FRC
  if (s.state === 'jettons-locked') {
    if (node.tip() >= s.frcCltv) {
      // our FRC claim window is closing and no secret appeared; the jettons will refund to us on their deadline
      log(s.id, 'FRC claim window closed without a secret — will refund jettons after their deadline');
      s.state = 'reverse-stuck'; store(s); return;
    }
    const tl = tonLock({ codeCell: HTLC_CODE, paymentHash: s.hash, deadline: s.tonDeadline,
      master: Address.parse(CFG.ton.jettonMaster), walletCode: t.j.walletCode, governed: CFG.ton.governed,
      sender: t.wallet.address, recipient: Address.parse(s.tonRecipient) });
    const preimage = await (await import('./ton-leg.mjs')).tonRevealedPreimage(t.client, tl);
    if (!preimage || sha256hex(Buffer.from(preimage, 'hex')) !== s.hash) return;
    log(s.id, 'secret revealed on TON — claiming the FRC');
    const claim = (await import('./frc-leg.mjs')).frcClaim({ node,
      lock: { leaf: s.frcLockLeaf, cltv: s.frcCltv },
      funding: { txid: s.frcLockInfo.txid, vout: s.frcLockInfo.vout, value: BigInt(s.frcAmount), refheight: s.frcLockInfo.refheight },
      preimage, claimKey: KEY, toSpk: frcWpkSpk(PUB), fee: BigInt(CFG.frc.fee) });
    s.state = 'done'; s.preimage = preimage; s.frcClaimTxid = claim.txid; store(s);
    log(s.id, 'done: FRC claimed', claim.txid);
  }

  // stuck: the visitor never claimed, our FRC window passed. Refund the jettons once their deadline hits.
  if (s.state === 'reverse-stuck' && secsLeft <= 0) {
    const tl = tonLock({ codeCell: HTLC_CODE, paymentHash: s.hash, deadline: s.tonDeadline,
      master: Address.parse(CFG.ton.jettonMaster), walletCode: t.j.walletCode, governed: CFG.ton.governed,
      sender: t.wallet.address, recipient: Address.parse(s.tonRecipient) });
    log(s.id, 'refunding our jettons');
    await (await import('./ton-leg.mjs')).tonRefund(t.wallet, tl, '0.15');
    s.state = 'jettons-refunded'; store(s);
  }
}

// find the visitor's FRC lock paying our expected spk; returns {txid, vout, refheight} or null
function frcLockFunded(s) {
  try {
    const scan = node.json('scantxoutset', 'start', JSON.stringify([`addr(${s.frcLockAddress})`]));
    const u = (scan.unspents || []).find(x => BigInt(Math.round(x.value * 1e8)) >= BigInt(s.frcAmount));
    return u ? { txid: u.txid, vout: u.vout, refheight: u.refheight } : null;
  } catch { return null; }
}

function preimageFromClaim(s) {
  try {
    const txid = s.frcClaimTxid;
    let raw;
    if (txid) raw = node.cli('getrawtransaction', txid);
    else {
      // spent behind our back: find the spender in the last few blocks
      for (let h = node.tip(); h > node.tip() - 20; h--) {
        const blk = node.json('getblock', node.cli('getblockhash', String(h)), 2);
        for (const tx of blk.tx) for (const vin of tx.vin ?? []) {
          if (vin.txid === s.frcLockInfo.txid && vin.vout === 0) { raw = node.cli('getrawtransaction', tx.txid); break; }
        }
        if (raw) break;
      }
    }
    if (!raw) return null;
    const d = node.json('decoderawtransaction', raw);
    for (const w of d.vin?.[0]?.txinwitness ?? []) {
      if (w.length === 64 && sha256hex(Buffer.from(w, 'hex')) === s.hash) return w;
    }
  } catch {}
  return null;
}

// ---- serve -------------------------------------------------------------------------------------
const MAX_BODY = 64 * 1024;
const server = createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Content-Type': 'application/json; charset=utf-8' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    const m = /^\/api\/(\w+)$/.exec(req.url ?? '');
    if (!m || !(m[1] in api)) { res.writeHead(404, cors); return res.end('{"error":"not found"}'); }
    let body = {};
    if (req.method === 'POST') body = await new Promise((ok, bad) => {
      let d = '', n = 0;
      req.on('data', c => { n += c.length; if (n > MAX_BODY) { bad(new Error('body too large')); req.destroy(); } else d += c; });
      req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch { bad(new Error('malformed JSON')); } });
      req.on('error', () => bad(new Error('stream error')));
    });
    const out = await api[m[1]](body);
    res.writeHead(200, cors);
    res.end(JSON.stringify(out, (k, v) => typeof v === 'bigint' ? String(v) : v));
  } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: e.message })); }
});

await ton();                                                    // fail fast if TON is unreachable
server.listen(CFG.port, '127.0.0.1', () => log(`tonswap daemon on :${CFG.port}, FRC ${CFG.frc.net}, jetton ${CFG.ton.jettonMaster}`));
setInterval(() => tick().catch(e => log('tick failed:', e.message?.slice(0, 200))), (CFG.tickSeconds ?? 20) * 1000);
