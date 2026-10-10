// Preload for the simulator while it talks to AWS (NODE_OPTIONS=--require ./dns-fallback.cjs).
// The system resolver on some home routers briefly caches failed lookups for AWS endpoints; when dns.lookup fails,
// ask the configured nameserver directly (dns.resolve4) and remember the last good address. Process-local only.
const dns = require("node:dns");
const original = dns.lookup;
const lastGood = new Map();

dns.lookup = function lookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  const opts = typeof options === "number" ? { family: options } : (options ?? {});
  original.call(dns, hostname, opts, (err, address, family) => {
    if (!err) {
      if (!opts.all && address) lastGood.set(hostname, [{ address, family }]);
      if (opts.all && Array.isArray(address)) lastGood.set(hostname, address);
      return callback(err, address, family);
    }
    if (!["ENOTFOUND", "EAI_AGAIN", "ESERVFAIL"].includes(err.code)) return callback(err);
    dns.resolve4(hostname, (err2, addrs) => {
      const list = !err2 && addrs?.length ? addrs.map((a) => ({ address: a, family: 4 })) : lastGood.get(hostname);
      if (!list?.length) return callback(err);
      lastGood.set(hostname, list);
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  });
};
