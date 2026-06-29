// NT hash (NTLM) = MD4(UTF-16LE(password)), uppercase hex. Implemented in pure JS because
// OpenSSL 3 moves MD4 to the legacy provider, so crypto.createHash('md4') is unreliable.
// Self-test: ntHash('password') === '8846F7EAEE8FB117AD06BDD830B7586C'.

function md4(bytes) {
  const rotl = (x, c) => ((x << c) | (x >>> (32 - c))) >>> 0
  const add = (...a) => a.reduce((s, v) => (s + v) >>> 0, 0)
  const F = (x, y, z) => (x & y) | (~x & z)
  const G = (x, y, z) => (x & y) | (x & z) | (y & z)
  const H = (x, y, z) => x ^ y ^ z

  const len = bytes.length
  const bitLen = len * 8
  // pad: 0x80, then zeros to 56 mod 64, then 64-bit little-endian length
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64)
  padded.set(bytes)
  padded[len] = 0x80
  for (let i = 0; i < 8; i++) padded[padded.length - 8 + i] = (bitLen / 2 ** (8 * i)) & 0xff

  let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476
  const x = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4
      x[i] = (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0
    }
    let [aa, bb, cc, dd] = [a, b, c, d]
    // Round 1
    const r1 = [3, 7, 11, 19]
    for (let i = 0; i < 16; i++) {
      const k = i
      const s = r1[i % 4]
      if (i % 4 === 0) aa = rotl(add(aa, F(bb, cc, dd), x[k]), s)
      else if (i % 4 === 1) dd = rotl(add(dd, F(aa, bb, cc), x[k]), s)
      else if (i % 4 === 2) cc = rotl(add(cc, F(dd, aa, bb), x[k]), s)
      else bb = rotl(add(bb, F(cc, dd, aa), x[k]), s)
    }
    // Round 2
    const r2 = [3, 5, 9, 13]
    const o2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]
    for (let i = 0; i < 16; i++) {
      const k = o2[i]
      const s = r2[i % 4]
      if (i % 4 === 0) aa = rotl(add(aa, G(bb, cc, dd), x[k], 0x5a827999), s)
      else if (i % 4 === 1) dd = rotl(add(dd, G(aa, bb, cc), x[k], 0x5a827999), s)
      else if (i % 4 === 2) cc = rotl(add(cc, G(dd, aa, bb), x[k], 0x5a827999), s)
      else bb = rotl(add(bb, G(cc, dd, aa), x[k], 0x5a827999), s)
    }
    // Round 3
    const r3 = [3, 9, 11, 15]
    const o3 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]
    for (let i = 0; i < 16; i++) {
      const k = o3[i]
      const s = r3[i % 4]
      if (i % 4 === 0) aa = rotl(add(aa, H(bb, cc, dd), x[k], 0x6ed9eba1), s)
      else if (i % 4 === 1) dd = rotl(add(dd, H(aa, bb, cc), x[k], 0x6ed9eba1), s)
      else if (i % 4 === 2) cc = rotl(add(cc, H(dd, aa, bb), x[k], 0x6ed9eba1), s)
      else bb = rotl(add(bb, H(cc, dd, aa), x[k], 0x6ed9eba1), s)
    }
    a = add(a, aa); b = add(b, bb); c = add(c, cc); d = add(d, dd)
  }

  const out = Buffer.alloc(16)
  ;[a, b, c, d].forEach((v, i) => out.writeUInt32LE(v, i * 4))
  return out
}

export function ntHash(password) {
  const utf16le = Buffer.from(String(password), 'utf16le')
  return md4(utf16le).toString('hex').toUpperCase()
}
