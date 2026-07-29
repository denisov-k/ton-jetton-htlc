import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Address, toNano, beginCell } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { readFileSync } from 'fs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const retry=async(fn,t=10)=>{for(let i=0;;i++){try{return await fn()}catch(e){if(i>=t)throw e;await sleep(3000*(i+1))}}};
const c=new TonClient({endpoint:process.env.TON_ENDPOINT||'https://toncenter.com/api/v2/jsonRPC'});
const {mnemonic}=JSON.parse(readFileSync(process.argv[2],'utf8'));
const k=await mnemonicToPrivateKey(mnemonic);
const w=c.open(WalletContractV4.create({workchain:0,publicKey:k.publicKey}));
const to=Address.parse(process.argv[3]);
const seqno=await retry(()=>w.getSeqno());
await retry(()=>w.sendTransfer({seqno,secretKey:k.secretKey,messages:[internal({to,value:toNano(process.argv[4]),bounce:false,body:beginCell().endCell()})]}));
for(let i=0;i<60;i++){await sleep(3000);try{if(await retry(()=>w.getSeqno(),2)>seqno)break}catch{}}
console.log('sent',process.argv[4],'TON; receiver has',Number(await retry(()=>c.getBalance(to)))/1e9);
