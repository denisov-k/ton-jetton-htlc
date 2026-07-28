// Would the contract find POK's jetton wallet? Take POK's real master and wallet code off mainnet,
// put them in the contract's storage with the governed layout, and let the contract's own get
// method answer. Compare with the layout that was verified against POK's master directly.
import { TonClient } from '@ton/ton';
import { Blockchain } from '@ton/sandbox';
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const POK = Address.parse('EQBp6FAkDdHD_lLKUBI-J-Et5zQeyJlixc6f3iKHBie85Fd-');
const HTLC_CODE = Cell.fromBase64(readFileSync('htlc.boc.b64', 'utf8'));

let codeB64;
if (existsSync('pok-wallet-code.b64')) codeB64 = readFileSync('pok-wallet-code.b64', 'utf8');
else {
  const client = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });
  const d = await client.runMethod(POK, 'get_jetton_data');
  d.stack.readBigNumber(); d.stack.readNumber(); d.stack.readAddressOpt(); d.stack.readCell();
  codeB64 = d.stack.readCell().toBoc().toString('base64');
  writeFileSync('pok-wallet-code.b64', codeB64);
}
const POK_WALLET_CODE = Cell.fromBase64(codeB64);
console.log('POK wallet code hash', POK_WALLET_CODE.hash().toString('hex'));

// the governed layout, the one that reproduced POK master's own get_wallet_address
const expectedWallet = (owner) => {
  const data = beginCell().storeUint(0, 4).storeCoins(0).storeAddress(owner).storeAddress(POK).endCell();
  const si = beginCell().storeUint(0, 2).storeMaybeRef(POK_WALLET_CODE).storeMaybeRef(data).storeUint(0, 1).endCell();
  return new Address(0, si.hash());
};

const dummy = Address.parse('0:0000000000000000000000000000000000000000000000000000000000000001');
const data = beginCell()
  .storeUint(1n, 256).storeUint(2000000000, 32)
  .storeUint(0, 1).storeUint(1, 1)                 // funded = 0, governed = 1
  .storeCoins(0)
  .storeRef(beginCell().storeAddress(POK).storeAddress(dummy).storeAddress(dummy).endCell())
  .storeRef(POK_WALLET_CODE)
  .endCell();

const bc = await Blockchain.create();
const deployer = await bc.treasury('deployer');
const init = { code: HTLC_CODE, data };
const htlc = contractAddress(0, init);
await deployer.send({ to: htlc, value: toNano('1'), init, body: beginCell().endCell() });

const fromContract = (await bc.runGetMethod(htlc, 'get_jetton_wallet')).stackReader.readAddress();
const fromJs = expectedWallet(htlc);
console.log('contract says :', fromContract.toString());
console.log('layout says   :', fromJs.toString());
console.log(fromContract.equals(fromJs)
  ? 'PASS  контракт находит кошелёк POK по управляемой раскладке'
  : 'FAIL  расходятся');
process.exit(fromContract.equals(fromJs) ? 0 : 1);
