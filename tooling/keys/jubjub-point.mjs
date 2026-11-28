// @ts-check
// Jubjub point checks (public keys only): on the curve and in the prime-order
// subgroup. Jubjub: -x^2 + y^2 = 1 + d x^2 y^2 over the BLS12-381 scalar field,
// d = -(10240/10241); subgroup order l (cofactor 8).
export const P = 0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001n;
export const L = 0x0e7db4ea6533afa906673b0101343b00a6682093ccc81082d0970e5ed6f72cb7n;
const mod = (/** @type {bigint} */ a) => ((a % P) + P) % P;
const pow = (/** @type {bigint} */ b, /** @type {bigint} */ e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const inv = (/** @type {bigint} */ a) => pow(a, P - 2n);
export const D = mod(-10240n * inv(10241n));
const A = P - 1n; // a = -1

/** @param {{x: bigint, y: bigint}} p */
export const onCurve = (p) => { const x2 = (p.x * p.x) % P, y2 = (p.y * p.y) % P; return mod(A * x2 + y2) === mod(1n + D * x2 % P * y2); };
/** @param {{x: bigint, y: bigint}} p @param {{x: bigint, y: bigint}} q */
const add = (p, q) => {
  const t = D * p.x % P * q.x % P * p.y % P * q.y % P;
  return { x: mod((p.x * q.y + p.y * q.x) * inv(1n + t)), y: mod((p.y * q.y - A * p.x * q.x) * inv(1n - t)) };
};
/** @param {{x: bigint, y: bigint}} p @param {bigint} k */
export const mul = (p, k) => { let r = { x: 0n, y: 1n }, b = p; while (k > 0n) { if (k & 1n) r = add(r, b); b = add(b, b); k >>= 1n; } return r; };

/** Throws unless p is a non-identity point of the prime-order subgroup. */
export function assertJubjubKey(/** @type {{x: bigint|string, y: bigint|string}} */ raw, /** @type {string} */ name) {
  const p = { x: BigInt(raw.x), y: BigInt(raw.y) };
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) throw new Error(`${name}: coordinate out of field range`);
  if (!onCurve(p)) throw new Error(`${name}: not on the Jubjub curve`);
  if (p.x === 0n) throw new Error(`${name}: identity or low-order point`);
  const z = mul(p, L);
  if (!(z.x === 0n && z.y === 1n)) throw new Error(`${name}: not in the prime-order subgroup`);
  return p;
}
