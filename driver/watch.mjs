// watch.mjs — the part that must not be asleep. Once both locks are up, a missed deadline is not
// an inconvenience, it is a loss: if the responder does not collect the coins before their timeout,
// the initiator refunds them and the jettons are already gone. So this walks every open swap in the
// journal on a timer, does whatever that swap's next step is, and takes its own money back when a
// deadline arrives with nothing to show for it.
//
//   SWAP_CONFIG=driver/config.json node driver/watch.mjs [--once]
//
// Safe to restart at any point: everything it needs is in the journal and on the two chains.
import { readdirSync, readFileSync } from 'fs';
import { CFG, load, store, node, ton, lockFor, take, collect, back } from './swap.mjs';
import { tonState, tonRevealedPreimage } from './ton-leg.mjs';
import { createHash } from 'crypto';

const DIR = CFG.journalDir || 'driver/swaps';
const sha256 = b => createHash('sha256').update(b).digest('hex');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DONE = new Set(['done', 'refunded', 'jettons-taken']);
const now = () => Math.floor(Date.now() / 1000);

const open = () => readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')))
  .filter(s => !DONE.has(s.state));

async function stepInitiator(s, ctx) {
  const n = node();
  const blocksLeft = s.frcCltv - n.tip();

  // their side up and sound? then take it — this is the step that reveals the secret
  const st = await tonState(ctx.client, lockFor(s, ctx.code, ctx.j));
  if (st.deployed && st.funded && st.hash === s.hash && st.amount >= BigInt(s.jettonAmount)) {
    const secondsLeft = st.deadline - now();
    if (secondsLeft < (CFG.minSeconds ?? 1800)) {
      log(s.id, `their lock expires in ${secondsLeft}s — too late to reveal, waiting for our refund`);
    } else {
      log(s.id, 'jetton lock is funded and sound — taking it');
      await take(s.id);
      return;
    }
  }

  // nothing came of it: once our own clock runs out, take the coins back
  if (blocksLeft <= 0) {
    log(s.id, 'our lock has expired — refunding the coins');
    try { await back(s.id); } catch (e) { log(s.id, 'refund not yet possible:', e.message); }
  } else {
    log(s.id, `waiting for their jetton lock (${blocksLeft} blocks left on ours)`);
  }
}

async function stepResponder(s, ctx) {
  const n = node();
  const tl = lockFor(s, ctx.code, ctx.j);

  // the secret is the only thing that matters here, and it can only come off the other chain
  const preimage = await tonRevealedPreimage(ctx.client, tl);
  if (preimage && sha256(Buffer.from(preimage, 'hex')) === s.hash) {
    log(s.id, 'secret is out — collecting the coins');
    await collect(s.id, { tries: 1, poll: 0 });
    return;
  }

  const blocksLeft = s.frcCltv - n.tip();
  const secondsLeft = s.tonDeadline - now();
  if (secondsLeft <= 0) {
    log(s.id, 'nobody took our jettons — refunding them');
    try { await back(s.id); } catch (e) { log(s.id, 'refund not yet possible:', e.message); }
  } else {
    log(s.id, `waiting for the secret (${secondsLeft}s on ours, ${blocksLeft} blocks on theirs)`);
  }
}

async function round() {
  const swaps = open();
  if (!swaps.length) { log('nothing open'); return; }
  const ctx = await ton();
  for (const s of swaps) {
    try {
      if (s.role === 'initiator') await stepInitiator(s, ctx);
      else await stepResponder(s, ctx);
    } catch (e) {
      // one broken swap must not stop the others, and the next round will try again
      log(s.id, 'step failed:', e.message);
    }
  }
}

const once = process.argv.includes('--once');
const every = Number(CFG.watchSeconds ?? 30) * 1000;
log(`watching ${DIR}` + (once ? ' (single pass)' : ` every ${every / 1000}s`));
do { await round(); if (!once) await sleep(every); } while (!once);
