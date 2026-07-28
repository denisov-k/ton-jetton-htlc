// swap.mjs — the driver. One swap, two sides, no trusted third party:
//
//   initiator (gives FRC, wants jettons)        responder (gives jettons, wants FRC)
//   ------------------------------------        --------------------------------------
//   offer    invents the secret, locks FRC  →   accept   checks that lock, locks jettons
//   take     checks the jetton lock, claims  →  (secret is now public on TON)
//            jettons and so reveals the secret  collect  reads the secret, claims FRC
//
// Every step is checkable before money moves, and every step has a way out: past its deadline each
// side can take its own money back. The one rule that must not be broken is the ordering of the
// two deadlines — whoever reveals the secret must be the one working against the shorter clock.
import { randomBytes, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { frcNode, frcLock, frcFund, frcClaim, frcRefund, frcAddress, frcWpkSpk, pubkeyCompressed } from './frc-leg.mjs';
import { tonClient, tonWallet, tonLock, tonDeploy, tonFund, tonClaim, tonRefund, tonState,
         tonRevealedPreimage, jetton, Address, Cell, toNano } from './ton-leg.mjs';

export const CFG = JSON.parse(readFileSync(process.env.SWAP_CONFIG || 'driver/config.json', 'utf8'));
const DIR = CFG.journalDir || 'driver/swaps';
const sha256 = b => createHash('sha256').update(b).digest('hex');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export const load = id => JSON.parse(readFileSync(`${DIR}/${id}.json`, 'utf8'));
export const store = s => { mkdirSync(DIR, { recursive: true }); writeFileSync(`${DIR}/${s.id}.json`, JSON.stringify(s, null, 2)); return s; };

export const node = () => frcNode({ bin: CFG.frc.cli, args: CFG.frc.args });
const myFrcKey = () => CFG.frc.key;
const myFrcPub = () => pubkeyCompressed(CFG.frc.key);

export async function ton() {
  const client = await tonClient(CFG.ton);
  const wallet = await tonWallet(client, CFG.ton.mnemonicFile);
  const j = await jetton(client, Address.parse(CFG.ton.jettonMaster));
  const code = Cell.fromBase64(readFileSync(CFG.ton.codeFile, 'utf8'));
  return { client, wallet, j, code };
}

// the contract both sides expect: same code, same lock, same parties — computed, never trusted
export const lockFor = (s, code, j) => tonLock({
  codeCell: code, paymentHash: s.hash, deadline: s.tonDeadline,
  master: Address.parse(CFG.ton.jettonMaster), walletCode: j.walletCode, governed: CFG.ton.governed,
  sender: Address.parse(s.ton.giver), recipient: Address.parse(s.ton.taker),
});

export const frcLockOf = s => frcLock({ paymentHash: s.hash, claimPub: s.frc.claimPub,
  refundPub: s.frc.refundPub, cltv: s.frcCltv, net: CFG.frc.net || 'main' });

// ---- initiator: invent the secret, lock the coins, publish the offer -------------------------
export async function offer({ frcAmount, jettonAmount, tonTaker, tonGiver }) {
  const { client, code, j } = await ton();
  const n = node();
  const secret = randomBytes(32).toString('hex');
  const s = {
    id: sha256(Buffer.from(secret, 'hex')).slice(0, 16), role: 'initiator', secret,
    hash: sha256(Buffer.from(secret, 'hex')),
    frcAmount: String(frcAmount), jettonAmount: String(jettonAmount),
    frcCltv: n.tip() + (CFG.frcBlocks ?? 24),
    tonDeadline: Math.floor(Date.now() / 1000) + (CFG.tonSeconds ?? 7200),
    frc: { claimPub: null, refundPub: myFrcPub(), payout: null },
    ton: { giver: tonGiver, taker: tonTaker },
    state: 'draft',
  };
  s.frc.claimPub = CFG.counterpartyFrcPub;         // who may take the coins with the secret
  s.frc.payout = frcWpkSpk(myFrcPub());            // where our refund goes
  const lock = frcLockOf(s);
  const funding = frcFund({ node: n, key: myFrcKey(), lock, amount: BigInt(s.frcAmount),
    fee: BigInt(CFG.frc.fee ?? 50000), net: CFG.frc.net || 'main', maturity: CFG.frc.maturity ?? 100 });
  s.frcFunding = { ...funding, value: String(funding.value), rawtx: undefined };
  s.frcAddress = lock.address;
  s.state = 'frc-locked';
  store(s);
  log('secret kept locally, lock published');
  log('FRC lock', lock.address, 'txid', funding.txid, 'until block', s.frcCltv);
  console.log('\n--- offer (send this to the other side) ---');
  console.log(JSON.stringify({ id: s.id, hash: s.hash, frcAmount: s.frcAmount, jettonAmount: s.jettonAmount,
    frcCltv: s.frcCltv, tonDeadline: s.tonDeadline, frcTxid: funding.txid, frcRefheight: funding.refheight,
    frcClaimPub: s.frc.claimPub, frcRefundPub: s.frc.refundPub, ton: s.ton }, null, 2));
  return s;
}

// ---- responder: check their lock, then lock the jettons --------------------------------------
export async function accept(offerJson) {
  const o = JSON.parse(readFileSync(offerJson, 'utf8'));
  const n = node();
  const s = { ...o, role: 'responder', state: 'checking',
    frc: { claimPub: o.frcClaimPub, refundPub: o.frcRefundPub }, secret: null };

  // 1. is their coin really locked, for the amount promised, under our claim key?
  const lock = frcLockOf(s);
  const out = n.outAt(o.frcTxid, 0);
  if (!out) throw new Error('their FRC lock is not on chain');
  if (out.scriptPubKey.hex !== lock.spk) throw new Error('the FRC output is not the lock we computed');
  const locked = BigInt(Math.round(out.value * 1e8));
  if (locked < BigInt(o.frcAmount)) throw new Error(`FRC lock holds ${locked}, expected ${o.frcAmount}`);
  if (o.frcClaimPub !== myFrcPub()) throw new Error('the FRC lock does not name our key as claimant');

  // 2. will there be time to collect after the secret shows up?
  const margin = o.frcCltv - n.tip();
  if (margin < (CFG.minBlocks ?? 12)) throw new Error(`only ${margin} blocks left on their lock`);
  const secondsLeft = o.tonDeadline - Math.floor(Date.now() / 1000);
  if (secondsLeft < (CFG.minSeconds ?? 1800)) throw new Error('their side would expire too soon');
  log('their FRC lock checks out:', locked.toString(), 'kria, until block', o.frcCltv, `(${margin} blocks away)`);

  // 3. our side of the deal
  const { client, wallet, j, code } = await ton();
  const tl = lockFor(s, code, j);
  s.tonAddress = tl.address.toString();
  if (!(await tonState(client, tl)).deployed) { log('deploying the jetton lock', s.tonAddress); await tonDeploy(wallet, client, tl); }
  const mine = await j.walletOf(wallet.address);
  log('locking', s.jettonAmount, 'units');
  await tonFund(wallet, mine, tl, BigInt(s.jettonAmount), wallet.address);
  for (let i = 0; i < 40; i++) {
    const st = await tonState(client, tl);
    if (st.funded) { log('jetton lock funded:', st.amount.toString()); break; }
    await new Promise(r => setTimeout(r, 4000));
  }
  s.state = 'both-locked'; store(s);
  console.log('\nnow the other side may take the jettons; run `collect` to watch for the secret');
}

// ---- initiator: check their lock, take the jettons, revealing the secret ----------------------
export async function take(id) {
  const s = load(id);
  const { client, wallet, j, code } = await ton();
  const tl = lockFor(s, code, j);
  const st = await tonState(client, tl);
  if (!st.deployed) throw new Error('their jetton lock is not deployed');
  if (!st.funded) throw new Error('their jetton lock is not funded');
  if (st.hash !== s.hash) throw new Error('the jetton lock carries a different hash');
  if (st.amount < BigInt(s.jettonAmount)) throw new Error(`locked ${st.amount}, expected ${s.jettonAmount}`);
  if (st.deadline - Math.floor(Date.now() / 1000) < (CFG.minSeconds ?? 1800)) throw new Error('too close to their deadline');
  // the contract must be OUR code, or the rules inside it are anyone's guess
  const onChain = (await client.getContractState(tl.address)).code;
  if (Buffer.compare(Cell.fromBoc(onChain)[0].hash(), code.hash()) !== 0) throw new Error('their contract is not the code we expect');
  log('their jetton lock checks out:', st.amount.toString(), 'units, same hash, our code');

  await tonClaim(wallet, tl, s.secret);
  s.state = 'jettons-taken'; store(s);
  log('jettons taken; the secret is now public on TON');
}

// ---- responder: read the secret off TON and take the coins -------------------------------------
export async function collect(id, { poll = 15000, tries = 240 } = {}) {
  const s = load(id);
  const { client, j, code } = await ton();
  const tl = lockFor(s, code, j);
  const n = node();
  for (let i = 0; i < tries; i++) {
    const preimage = await tonRevealedPreimage(client, tl);
    if (preimage && sha256(Buffer.from(preimage, 'hex')) === s.hash) {
      log('secret spotted on TON:', preimage);
      const lock = frcLockOf(s);
      const r = frcClaim({ node: n, lock,
        funding: { txid: s.frcTxid, vout: 0, value: BigInt(s.frcAmount), refheight: s.frcRefheight },
        preimage, claimKey: myFrcKey(), toSpk: frcWpkSpk(myFrcPub()), fee: BigInt(CFG.frc.fee ?? 50000) });
      s.state = 'done'; s.secret = preimage; s.frcClaimTxid = r.txid; store(s);
      log('FRC claimed:', r.txid);
      return;
    }
    if (n.tip() >= s.frcCltv) { log('their lock has expired without a secret — nothing to collect'); return; }
    await new Promise(r => setTimeout(r, poll));
  }
  log('gave up waiting; the FRC lock is still refundable by them, our jettons by us');
}

// ---- either side: take your own money back once your deadline has passed ------------------------
export async function back(id) {
  const s = load(id);
  if (s.role === 'initiator') {
    const n = node();
    if (n.tip() < s.frcCltv) throw new Error(`too early: ${s.frcCltv - n.tip()} blocks to go`);
    const r = frcRefund({ node: n, lock: frcLockOf(s),
      funding: { txid: s.frcTxid ?? s.frcFunding.txid, vout: 0, value: BigInt(s.frcAmount), refheight: s.frcFunding.refheight },
      refundKey: myFrcKey(), toSpk: frcWpkSpk(myFrcPub()), fee: BigInt(CFG.frc.fee ?? 50000) });
    log('FRC refunded:', r.txid);
  } else {
    const { client, wallet, j, code } = await ton();
    const tl = lockFor(s, code, j);
    if (Math.floor(Date.now() / 1000) < s.tonDeadline) throw new Error('too early for the jetton refund');
    await tonRefund(wallet, tl);
    log('jettons refunded');
  }
  s.state = 'refunded'; store(s);
}

export async function status(id) {
  const s = load(id);
  const { client, j, code } = await ton();
  const st = await tonState(client, lockFor(s, code, j));
  const n = node();
  console.log(JSON.stringify({ id: s.id, role: s.role, state: s.state, hash: s.hash,
    frc: { lock: s.frcAddress ?? frcLockOf(s).address, spent: !n.outAt(s.frcTxid ?? s.frcFunding?.txid, 0),
           cltv: s.frcCltv, blocksLeft: s.frcCltv - n.tip() },
    ton: { ...st, amount: st.amount?.toString(), secondsLeft: s.tonDeadline - Math.floor(Date.now() / 1000) } }, null, 2));
}

// the CLI only runs when this file is what was launched
const entry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
const [cmd, ...rest] = entry ? process.argv.slice(2) : [];
const arg = (k, d) => { const i = rest.indexOf('--' + k); return i < 0 ? d : rest[i + 1]; };
if (entry) switch (cmd) {
  case 'offer':   await offer({ frcAmount: BigInt(arg('frc')), jettonAmount: BigInt(arg('jettons')),
                                tonTaker: arg('to'), tonGiver: arg('from') }); break;
  case 'accept':  await accept(arg('file')); break;
  case 'take':    await take(arg('id')); break;
  case 'collect': await collect(arg('id')); break;
  case 'refund':  await back(arg('id')); break;
  case 'status':  await status(arg('id')); break;
  default:
    console.log(`usage:
  offer   --frc <kria> --jettons <units> --from <their TON address> --to <our TON address>
  accept  --file offer.json
  take    --id <swap id>
  collect --id <swap id>
  refund  --id <swap id>
  status  --id <swap id>`);
}
