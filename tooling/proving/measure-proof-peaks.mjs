// Measures the proof server's memory per proof (Garrett, 2026-11-25).
// Runs the given stack stages (NOT a full pass) on a separate devnet state
// file while sampling the proof-server container's cgroup memory every second
// on the docker host, then reports, per proof (the stack's log line that
// follows it), the peak memory.current, plus the cgroup's own memory.peak.
//
//   DEVNET_STATE_FILE=build/devnet/measure-state.json MIDNIGHT_*=... \
//     node tooling/proving/measure-proof-peaks.mjs tariff
//
// Env: PROOF_HOST (ssh host, default kenya), PROOF_CONTAINER (default
// wi16-proof-server). Refuses unless the container runs one job / one worker.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.PROOF_HOST ?? 'kenya';
const CT = process.env.PROOF_CONTAINER ?? 'wi16-proof-server';
const stages = process.argv.slice(2);
if (!stages.length || stages.includes('all')) { console.error('usage: measure-proof-peaks.mjs <stage> [...] (never all)'); process.exit(2); }
if (!process.env.DEVNET_STATE_FILE) { console.error('DEVNET_STATE_FILE is required (never the pass state)'); process.exit(2); }
const ssh = (/** @type {string} */ cmd) => execFileSync('ssh', ['-o', 'ConnectTimeout=15', HOST, cmd], { encoding: 'utf8' }).trim();
const GB = (/** @type {number} */ b) => `${(b / 2 ** 30).toFixed(2)} GiB`;

const env = ssh(`docker inspect -f '{{json .Config.Env}} {{.HostConfig.Memory}} {{.Id}}' ${CT}`);
const [envJson, cap, id] = env.split(' ');
const vars = Object.fromEntries(JSON.parse(envJson).map((/** @type {string} */ kv) => kv.split('=')));
if (vars.MIDNIGHT_PROOF_SERVER_JOB_CAPACITY !== '1' || vars.MIDNIGHT_PROOF_SERVER_NUM_WORKERS !== '1') {
  console.error(`refusing: ${CT} must run with MIDNIGHT_PROOF_SERVER_JOB_CAPACITY=1 and MIDNIGHT_PROOF_SERVER_NUM_WORKERS=1 (has ${vars.MIDNIGHT_PROOF_SERVER_JOB_CAPACITY ?? 'default 10'} / ${vars.MIDNIGHT_PROOF_SERVER_NUM_WORKERS ?? 'default 2'})`);
  process.exit(3);
}
const cg = `/sys/fs/cgroup/system.slice/docker-${id}.scope`;
console.log(`[measure] ${CT}: job capacity 1, 1 worker, cap ${cap === '0' ? 'none' : GB(Number(cap))}; restarting it for a clean peak`);
ssh(`docker restart ${CT} >/dev/null`);
const id2 = ssh(`docker inspect -f '{{.Id}}' ${CT}`);
const cg2 = `/sys/fs/cgroup/system.slice/docker-${id2}.scope`;
void cg;

/** @type {{ t: number, b: number }[]} */
const samples = [];
const sampler = spawn('ssh', ['-o', 'ConnectTimeout=15', HOST, `while true; do echo "$(date +%s.%N) $(cat ${cg2}/memory.current 2>/dev/null || echo 0)"; sleep 1; done`]);
let sbuf = '';
sampler.stdout.on('data', (d) => {
  sbuf += d; const lines = sbuf.split('\n'); sbuf = lines.pop() ?? '';
  for (const l of lines) { const [t, b] = l.split(' ').map(Number); if (b) samples.push({ t: t * 1000, b }); }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** @type {{ t: number, line: string }[]} */
const marks = [];
const child = spawn(process.execPath, [path.join(ROOT, 'tooling', 'devnet', 'stack.mjs'), ...stages], { env: process.env });
let cbuf = '';
const onOut = (/** @type {Buffer} */ d) => {
  process.stdout.write(d);
  cbuf += d; const lines = cbuf.split('\n'); cbuf = lines.pop() ?? '';
  for (const l of lines) if (/^\[stack\]\s+(council slot|schedule registered|class retuned|statutory lane registered|TR action log)/.test(l) || /approved|registered|retuned/.test(l)) marks.push({ t: Date.now(), line: l.trim() });
};
child.stdout.on('data', onOut);
child.stderr.on('data', (d) => process.stderr.write(d));
const code = await new Promise((r) => child.on('exit', r));
await new Promise((r) => setTimeout(r, 2000));
sampler.kill();
const peak = Number(ssh(`cat ${cg2}/memory.peak`));
const oom = ssh(`docker inspect -f '{{.State.OOMKilled}} {{.State.Status}}' ${CT}`);

console.log('\n[measure] per proof (max memory.current between log marks; 1 s sampling):');
let from = samples[0]?.t ?? 0;
for (const m of marks) {
  const w = samples.filter((s) => s.t > from && s.t <= m.t);
  console.log(`  ${w.length ? GB(Math.max(...w.map((s) => s.b))).padStart(10) : '   (none)'}  ${m.line.slice(0, 110)}`);
  from = m.t;
}
console.log(`[measure] cgroup memory.peak since restart: ${GB(peak)} (${peak} bytes); container ${oom}; stack exit ${code}`);
process.exit(code === 0 ? 0 : 1);
