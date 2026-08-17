import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';

const LD_ADDR = 'efccdb2348f98c496f8fd5925a6961c3d81966eab562b928ab9765264dc7fd30';
const EXPECTED_COLOR = '3862ec542440e4d3c591fa0c72c46cab0402b6f15114be6b0a51d1d341e6795c';
const EXPECTED_AUTH  = 'cb564026d1028c0c7cd3c22512f0e302df28fd05ba8939bf230010546c479cb4';

const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
setNetworkId('preview');

// Load LD compiled ledger reader + providers via the same utils the deploy used.
const dep = JSON.parse(fs.readFileSync('/home/pollpower/contracts/ebt/deployment.json','utf8'));
const utils = await import(pathToFileURL('/opt/pollpower/settlement-api/src/utils-runtime.js').href);
const walletCtx = await utils.createWallet(dep.seed);
let providers = await utils.createProviders(walletCtx, '/home/pollpower/contracts/living-dividend/build');
providers = utils.withZkConfigDir(providers, '/home/pollpower/contracts/living-dividend/build/v2.2.1');

const build = await import(pathToFileURL('/home/pollpower/contracts/living-dividend/build/v2.2.1/contract/index.js').href);
const hex = (u8)=>Buffer.from(u8).toString('hex');

// Read raw ledger state from the public data provider, then decode via the build's ledger()
const pdp = providers.publicDataProvider;
const st = await pdp.queryContractState(LD_ADDR);
if(!st){ console.log('NO CONTRACT STATE at address (indexer not caught up yet?)'); process.exit(2); }
let ledger;
try { ledger = build.ledger(st.data); }
catch(e){ console.log('ledger decode threw:', e.message); process.exit(3); }

function g(name){ try{ return ledger[name]; }catch(e){ return '<err '+e.message+'>'; } }
console.log('LD address        :', LD_ADDR);
console.log('_initialized      :', g('_initialized'));
const color = g('_ebtColor'); console.log('_ebtColor         :', color && color.length!==undefined?hex(color):color);
const auth = g('_multisigAuthority'); console.log('_multisigAuthority:', auth && auth.length!==undefined?hex(auth):auth);
console.log('_totalLivingMembers:', String(g('_totalLivingMembers')));
console.log('_accPerShare      :', String(g('_accPerShare')));
console.log('_totalPoolReceived:', String(g('_totalPoolReceived')));
console.log('_totalClaimed     :', String(g('_totalClaimed')));
console.log('_registrationCount:', String(g('_registrationCount')));
console.log('_bumpCount        :', String(g('_bumpCount')));
console.log('_claimCount       :', String(g('_claimCount')));

const colorHex = color && color.length!==undefined?hex(color):'';
const authHex = auth && auth.length!==undefined?hex(auth):'';
console.log('---checks---');
console.log('color matches v8  :', colorHex===EXPECTED_COLOR ? 'YES ✅' : 'NO ❌ ('+colorHex+')');
console.log('authority matches :', authHex===EXPECTED_AUTH ? 'YES ✅' : 'NO ❌ ('+authHex+')');
console.log('initialized true  :', g('_initialized')===true ? 'YES ✅' : 'NO ❌');
