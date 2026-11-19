// MyChat — exact arithmetic for numeric claims. Models estimate; this computes.
// Rational numbers with BigInt (no floating-point error), + - * / ^ ( ), percent ("15% of 80", "80 * 15%"),
// decimals, thousands separators. evaluate() returns a rational; approxEqual() compares a claimed value.

const gcd = (a, b) => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };
class Q {
  constructor(n, d = 1n) {
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d) || 1n;
    this.n = n / g; this.d = d / g;
  }
  static from(s) {
    s = String(s).replace(/,/g, "");
    const m = s.match(/^(-?)(\d*)(?:\.(\d+))?$/);
    if (!m) throw new Error("bad number " + s);
    const frac = m[3] || "";
    const n = BigInt((m[2] || "0") + frac) * (m[1] ? -1n : 1n);
    return new Q(n, 10n ** BigInt(frac.length));
  }
  add(o) { return new Q(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o) { return new Q(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o) { return new Q(this.n * o.n, this.d * o.d); }
  div(o) { return new Q(this.n * o.d, this.d * o.n); }
  pow(o) {
    if (o.d !== 1n) throw new Error("only whole powers are exact");
    let e = o.n < 0n ? -o.n : o.n;
    if (e > 4096n) throw new Error("power too large");
    let r = new Q(1n), b = this;
    while (e) { if (e & 1n) r = r.mul(b); b = b.mul(b); e >>= 1n; }
    return o.n < 0n ? new Q(r.d, r.n) : r;
  }
  toNumber() { return Number(this.n) / Number(this.d); }
  toString(dp = 10) {
    if (this.d === 1n) return this.n.toString();
    const neg = this.n < 0n, n = neg ? -this.n : this.n;
    const ip = n / this.d;
    let rem = n % this.d, s = "";
    for (let i = 0; i < dp && rem; i++) { rem *= 10n; s += (rem / this.d).toString(); rem %= this.d; }
    return (neg ? "-" : "") + ip + (s ? "." + s.replace(/0+$/, "") : "");
  }
}

function tokenize(src) {
  const s = src.toLowerCase().replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-").replace(/\s+of\s+/g, " of ");
  const out = [];
  const re = /\s*(\d[\d,]*(?:\.\d+)?|\.\d+|of|[-+*/^()%])/y;
  let i = 0;
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) { if (/\s/.test(s[i])) { i++; continue; } throw new Error("cannot read: " + s.slice(i, i + 12)); }
    out.push(m[1]);
    i = re.lastIndex;
  }
  return out;
}

/** Evaluate an arithmetic expression exactly. Throws on anything that is not plain arithmetic. */
export function evaluate(expr) {
  const t = tokenize(expr);
  let p = 0;
  const peek = () => t[p], next = () => t[p++];
  function primary() {
    const x = next();
    if (x === "(") { const v = sum(); if (next() !== ")") throw new Error("missing )"); return post(v); }
    if (x === "-") return primary().mul(new Q(-1n));
    if (x === "+") return primary();
    if (x === undefined) throw new Error("unexpected end");
    if (/^[\d.]/.test(x)) return post(Q.from(x));
    throw new Error("unexpected " + x);
  }
  function post(v) {
    while (peek() === "%") { next(); v = v.div(new Q(100n)); if (peek() === "of") { next(); v = v.mul(power()); } }
    return v;
  }
  function power() { const b = primary(); if (peek() === "^") { next(); return b.pow(power()); } return b; }
  function prod() {
    let v = power();
    for (;;) {
      if (peek() === "*") { next(); v = v.mul(power()); } else if (peek() === "/") { next(); v = v.div(power()); }
      else if (peek() === "of") { next(); v = v.mul(power()); } else return v;
    }
  }
  function sum() {
    let v = prod();
    for (;;) { if (peek() === "+") { next(); v = v.add(prod()); } else if (peek() === "-") { next(); v = v.sub(prod()); } else return v; }
  }
  const v = sum();
  if (p !== t.length) throw new Error("unexpected " + t[p]);
  return v;
}

/** Is `claimed` (a number or numeric string) equal to the exact value, within rounding of the claimed precision? */
export function approxEqual(exact, claimed) {
  const s = String(claimed).replace(/,/g, "").trim();
  const c = Number(s);
  if (!Number.isFinite(c)) return false;
  const dec = (s.split(".")[1] || "").length;
  const tol = 0.5 * 10 ** -dec + 1e-12 * Math.max(1, Math.abs(c));
  return Math.abs(exact.toNumber() - c) <= tol;
}

export { Q };
