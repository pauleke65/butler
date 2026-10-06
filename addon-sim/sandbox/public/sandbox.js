// Sandbox proxy for MCP Apps views (runs on its own origin, e.g. http://localhost:3001).
// Protocol: spec 2026-01-26, "Sandbox proxy". The outer page is this proxy; the view lives in an inner iframe
// that shares THIS origin, never the host's. Messages are relayed untouched except ui/notifications/sandbox-*.
(function () {
  "use strict";
  var ALLOWED_REFERRER = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/;
  var RESOURCE_READY = "ui/notifications/sandbox-resource-ready";
  var PROXY_READY = "ui/notifications/sandbox-proxy-ready";
  var FIRST_RENDER = "ui/notifications/sandbox-first-render";
  var TOOL_RESULT = "ui/notifications/tool-result";

  if (window.self === window.top) throw new Error("This page is only to be used in an iframe sandbox.");
  if (!document.referrer) throw new Error("No referrer, cannot validate embedding site.");
  var extra = (document.querySelector('meta[name="allowed-host"]') || {}).content;
  if (!ALLOWED_REFERRER.test(document.referrer) && !(extra && document.referrer.indexOf(extra) === 0)) {
    throw new Error("Embedding domain not allowed: " + document.referrer);
  }
  var HOST_ORIGIN = new URL(document.referrer).origin;
  var OWN_ORIGIN = window.location.origin;

  // Self-test: if the top window were reachable the sandbox would be unsafe.
  try {
    window.top.alert("sandbox is not isolated");
    throw "FAIL";
  } catch (e) {
    if (e === "FAIL") throw new Error("The sandbox is not set up securely.");
  }

  var inner = document.createElement("iframe");
  inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  document.body.appendChild(inner);

  var observer = null;
  function measureFirstRender() {
    // Time from the host handing the tool result to the view until the view first mutates and paints.
    var t0 = performance.now();
    var doc = inner.contentDocument;
    if (!doc || !doc.documentElement) return;
    if (observer) observer.disconnect();
    observer = new MutationObserver(function () {
      observer.disconnect();
      observer = null;
      var mutatedAt = performance.now();
      var sent = false;
      function send(ms) {
        if (sent) return;
        sent = true;
        window.parent.postMessage({ jsonrpc: "2.0", method: FIRST_RENDER, params: { ms: Math.round(ms) } }, HOST_ORIGIN);
      }
      // Painted time when the page is visible; background tabs pause rAF, so fall back to the DOM-change time.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { send(performance.now() - t0); });
      });
      setTimeout(function () { send(mutatedAt - t0); }, 120);
    });
    // Content changes count; inline style churn on <html>/<body> (autoResize, theme) does not.
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden", "src", "data-state"] });
    setTimeout(function () { if (observer) { observer.disconnect(); observer = null; } }, 15000);
  }

  function allowAttr(p) {
    if (!p) return "";
    var out = [];
    if (p.camera) out.push("camera *");
    if (p.microphone) out.push("microphone *");
    if (p.geolocation) out.push("geolocation *");
    if (p.clipboardWrite) out.push("clipboard-write *");
    return out.join("; ");
  }

  window.addEventListener("message", function (event) {
    if (event.source === window.parent) {
      if (event.origin !== HOST_ORIGIN) return;
      var d = event.data;
      if (d && d.method === RESOURCE_READY) {
        var p = d.params || {};
        if (typeof p.sandbox === "string") inner.setAttribute("sandbox", p.sandbox);
        var allow = allowAttr(p.permissions);
        if (allow) inner.setAttribute("allow", allow);
        if (typeof p.html === "string") {
          var doc = inner.contentDocument || (inner.contentWindow && inner.contentWindow.document);
          if (doc) { doc.open(); doc.write(p.html); doc.close(); } else { inner.srcdoc = p.html; }
        }
        return;
      }
      if (d && d.method === TOOL_RESULT) measureFirstRender();
      if (inner.contentWindow) inner.contentWindow.postMessage(event.data, "*");
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN) return;
      window.parent.postMessage(event.data, HOST_ORIGIN);
    }
  });

  window.parent.postMessage({ jsonrpc: "2.0", method: PROXY_READY, params: {} }, HOST_ORIGIN);
})();
