/*
 * netplay.js — online 2-player transport + lobby UI for the XOX/Connect Four
 * clone. Classic (non-module) script, mirrors connect4.js's pattern: one
 * IIFE, one injected <style>, one global bridge object (window.__net).
 *
 * Transport: Trystero (WebRTC data channels over public Nostr relays), lazy
 * dynamic-imported only when the player actually picks Online — 1P and
 * local-2P play never touch the network or load this dependency.
 *
 * IMPORTANT: this file must never call navigator.mediaDevices/getUserMedia
 * or room.addStream/addTrack — data-channel-only, no permission prompts.
 *
 * NOTE ON RECONNECTION: a page reload or tab close mid-game is NOT
 * recovered. All WebRTC/room state lives in memory only. On reload the
 * local player restarts at the welcome screen; the surviving peer is given
 * a forfeit win once its onPeerLeave fires. Building real resync would need
 * persisting {room,role,seq,board} every move plus a resync handshake —
 * disproportionate for sub-minute rounds of a 9-cell/42-slot game.
 */
(function () {
  "use strict";

  var APP_ID = "stevo-madman-xoxo-v1";
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 confusables
  var CODE_LEN = 6;
  // Round numbers and peer filtering were added in protocol 2.  Refuse an
  // older page during the hello handshake instead of desynchronising in play.
  var PROTO = 2;
  var DEFAULT_AVATAR = "F1:N1:ST1:E9:D0:H5:B6:HT3:J3:JT1:T2:HT4";
  // Paste TURN credentials here to fix the ~5-15% of network pairs that can't
  // establish a direct P2P link. Requires a free account at expressturn.com
  // (100GB/mo free) or metered.ca/openrelay (20GB/mo free). Leave empty for none.
  var NET_TURN = [];
  // Vended from the pinned 0.25.3 ESM bundle; see vendor/README.md.
  // Online play must never execute a CDN response that can change after deploy.
  var CDNS = ["./vendor/trystero-0.25.3.mjs"];
  var HOST_WAIT_MS = 120000, GUEST_WAIT_MS = 20000, HELLO_WAIT_MS = 15000, REMATCH_WAIT_MS = 30000;

  function sfx(name) {
    try { (window.__xoxBridge && window.__xoxBridge.sfx || function () {})(name); } catch (e) { /* noop */ }
  }

  /* ------------------------------------------------------------------ *
   *  Library loading — dynamic import, tried lazily, only for Online play
   * ------------------------------------------------------------------ */
  var libPromise = null;
  function loadLib() {
    if (libPromise) return libPromise;
    if (navigator.onLine === false) {
      return Promise.reject(Object.assign(new Error("offline"), { code: "offline" }));
    }
    libPromise = (async function () {
      var lastErr = null;
      for (var i = 0; i < CDNS.length; i++) {
        try {
          var mod = await import(/* webpackIgnore: true */ CDNS[i]);
          if (mod && mod.joinRoom) return mod;
        } catch (e) { lastErr = e; }
      }
      throw Object.assign(new Error("libload"), { code: "libload", cause: lastErr });
    })();
    libPromise = libPromise.catch(function (error) {
      // A failed CDN request must not poison every later "TRY AGAIN" attempt.
      libPromise = null;
      throw error;
    });
    return libPromise;
  }

  /* ------------------------------------------------------------------ *
   *  Room / connection state
   * ------------------------------------------------------------------ */
  var room = null;
  var actions = null; // { hello, move, ctl }
  var role = null; // "host" | "guest"
  var firstIsHost = true;
  var peerId = null;
  var peerAvatar = null;
  var gameKind = "xo"; // "xo" | "c4", whichever the live game actually is
  var moveCount = 0;
  var rematchNo = 0;
  var connected = false; // true once hello exchange completes
  var moveCb = null; // (index) => void, wired by the active game via onMove()
  var lostCb = null; // (result) => void, wired by the active game via onLost()
  var pendingJoinCode = null;
  var pendingReady = null;
  var rematchTimer = null;

  (function readJoinParam() {
    try {
      var v = new URLSearchParams(location.search).get("join");
      if (v && new RegExp("^[" + CODE_ALPHABET + "]{" + CODE_LEN + "}$", "i").test(v)) {
        pendingJoinCode = v.toUpperCase();
      }
    } catch (e) { /* noop */ }
  })();

  function genCode() {
    var bytes = new Uint8Array(CODE_LEN);
    crypto.getRandomValues(bytes);
    var s = "";
    for (var i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    return s;
  }

  function amIFirst() { return (role === "host") === firstIsHost; }
  function xoSide() { return amIFirst() ? "X" : "O"; }
  function c4Side() { return amIFirst() ? 1 : 2; }
  function isConnected() { return connected && !!room; }

  function validAvatar(s) {
    return typeof s === "string" && /^[A-Za-z0-9:]{1,80}$/.test(s) ? s : DEFAULT_AVATAR;
  }

  function teardownRoom() {
    if (room) { try { room.leave(); } catch (e) { /* noop */ } }
    if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; }
    room = null; actions = null; connected = false; peerId = null; peerAvatar = null; pendingReady = null;
  }

  function senderId(meta) {
    if (typeof meta === "string") return meta;
    return meta && (meta.peerId || meta.id || meta.senderId) || null;
  }

  function fromAcceptedPeer(meta) {
    var id = senderId(meta);
    return !id || !peerId || id === peerId;
  }

  window.addEventListener("beforeunload", function () {
    if (actions && actions.ctl) { try { actions.ctl.send({ k: "bye" }); } catch (e) { /* noop */ } }
  });

  /* ------------------------------------------------------------------ *
   *  Move relay dispatch — shared by XO and Connect Four once connected.
   *  Authority model: no authority. Both peers simulate deterministically
   *  off one ordered, reliable data-channel stream (see class-level comment).
   * ------------------------------------------------------------------ */
  function applyRemoteIndex(i) {
    if (gameKind === "c4") return window.__c4 && window.__c4.remoteMove ? window.__c4.remoteMove(i) : false;
    var glapp = window.__xoxBridge && window.__xoxBridge.glapp;
    return glapp && glapp.game && glapp.game.applyRemoteMove ? glapp.game.applyRemoteMove(i) : false;
  }

  function abortActiveGame(result) {
    try {
      if (gameKind === "c4") { window.__c4 && window.__c4.abort && window.__c4.abort(result); }
      else { var glapp = window.__xoxBridge && window.__xoxBridge.glapp; glapp && glapp.game && glapp.game.abort && glapp.game.abort(result); }
    } catch (e) { console.warn("netplay: abortActiveGame failed", e); }
  }

  function wireDataHandlers() {
    actions.move.onMessage = function (msg, meta) {
      try {
        if (!fromAcceptedPeer(meta)) return;
        if (!msg || typeof msg.n !== "number" || typeof msg.i !== "number") throw new Error("malformed");
        if (msg.r !== rematchNo) { sendDesync(moveCount + 1); return; }
        if (msg.n !== moveCount + 1) {
          console.warn("netplay: desync, expected n=" + (moveCount + 1) + " got " + msg.n);
          sendDesync(moveCount + 1);
          return;
        }
        var ok = applyRemoteIndex(msg.i);
        if (!ok) { sendDesync(moveCount + 1); return; }
        moveCount = msg.n;
        if (moveCb) moveCb(msg.i);
      } catch (e) { console.warn("netplay: move handler error", e); sendDesync(moveCount + 1); }
    };
    actions.ctl.onMessage = function (msg, meta) {
      try {
        if (!fromAcceptedPeer(meta)) return;
        if (!msg || typeof msg.k !== "string") return;
        if (msg.k === "desync") { toastAndAbort("draw", "OUT OF SYNC — GAME ABANDONED"); return; }
        if (msg.k === "bye") { onPeerGone(); return; }
        if (msg.k === "full" && fullCb) { fullCb(); return; }
        if (msg.k === "ready") {
          pendingReady = msg;
          if (rematchResolve) rematchResolve(msg);
        }
      } catch (e) { console.warn("netplay: ctl handler error", e); }
    };
  }

  function sendDesync(n) {
    try { actions.ctl.send({ k: "desync", n: n }); } catch (e) { /* noop */ }
    toastAndAbort("draw", "OUT OF SYNC — GAME ABANDONED");
  }

  function toastAndAbort(result, message) {
    showToast(message);
    abortActiveGame(result);
    if (lostCb) lostCb(result);
  }

  function onPeerGone() {
    if (connected) {
      connected = false;
      showToast("OPPONENT LEFT — YOU WIN BY FORFEIT");
      abortActiveGame("win");
      if (lostCb) lostCb("win");
    }
    if (rematchReject) {
      var r = rematchReject; rematchReject = null; rematchResolve = null;
      removeOverlay(); teardownRoom();
      r(Object.assign(new Error("peer-left"), { code: "peer-left" }));
    }
    if (lobbyReject) {
      var l = lobbyReject; lobbyReject = null;
      removeOverlay(); teardownRoom();
      l(Object.assign(new Error("peer-left"), { code: "peer-left" }));
    }
  }

  function sendMoveIndex(i) {
    if (!actions) return;
    try {
      actions.move.send({ n: moveCount + 1, i: i, r: rematchNo });
      moveCount++;
    } catch (e) { console.warn("netplay: send failed", e); }
  }

  function onMove(cb) { moveCb = cb; }
  function onLost(cb) { lostCb = cb; }

  /* ------------------------------------------------------------------ *
   *  Room lifecycle
   * ------------------------------------------------------------------ */
  var joinErrorCb = null;
  var fullCb = null;
  function openRoom(code, asRole) {
    return loadLib().then(function (lib) {
      teardownRoom();
      role = asRole;
      var cfg = {
        appId: APP_ID,
        relayConfig: { redundancy: 4, warnOnRelayFailure: false }
      };
      if (NET_TURN.length) cfg.turnConfig = NET_TURN;
      room = lib.joinRoom(cfg, code, {
        handshakeTimeoutMs: 10000,
        onJoinError: function (details) { if (joinErrorCb) joinErrorCb(details); }
      });
      var helloAction = room.makeAction("hello");
      var moveAction = room.makeAction("move");
      var ctlAction = room.makeAction("ctl");
      actions = { hello: helloAction, move: moveAction, ctl: ctlAction };
      wireDataHandlers();
      return room;
    });
  }

  /* ------------------------------------------------------------------ *
   *  Lobby overlay — full UI-driven async flow producing
   *  {role, mode, opponent, side, firstIsHost} or rejecting with a
   *  {code: "..."} tagged error the caller can show copy for.
   * ------------------------------------------------------------------ */
  var lobbyReject = null;
  var rematchResolve = null, rematchReject = null;
  var overlayEl = null;

  function injectStyle() {
    if (document.getElementById("net-style")) return;
    var st = document.createElement("style");
    st.id = "net-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  var CSS = "\n" +
    ".net-overlay{position:fixed;inset:0;z-index:var(--z-popin,200);display:flex;align-items:center;justify-content:center;\n" +
    "  background:var(--color-pink,#b6f5a0);font-family:var(--font-bangers);}\n" +
    ".net-card{display:flex;flex-direction:column;align-items:center;gap:22px;padding:20px;max-width:640px;text-align:center;}\n" +
    ".net-h{color:#fff;text-transform:uppercase;letter-spacing:.03em;font-size:clamp(28px,5vw,46px);line-height:1;\n" +
    "  text-shadow:3px 3px 0 #000,-3px 3px 0 #000,3px -3px 0 #000,-3px -3px 0 #000;}\n" +
    ".net-p{color:#fff;font-family:Poppins,sans-serif;font-size:16px;max-width:480px;line-height:1.4;\n" +
    "  text-shadow:1px 1px 0 #000,-1px 1px 0 #000,1px -1px 0 #000,-1px -1px 0 #000;}\n" +
    ".net-row{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;}\n" +
    ".net-btn{cursor:pointer;border:3px solid #000;border-radius:999px;background:#fff;color:#204a78;\n" +
    "  font-family:var(--font-bangers);text-transform:uppercase;font-size:clamp(16px,2.2vw,22px);letter-spacing:.03em;\n" +
    "  line-height:1;padding:12px 30px 9px;box-shadow:5px 5px 0 #000;transform:rotate(-2deg);\n" +
    "  transition:transform .15s,box-shadow .15s;}\n" +
    ".net-btn:hover{transform:rotate(-2deg) scale(1.06);}\n" +
    ".net-btn.net-b{transform:rotate(2deg);} .net-btn.net-b:hover{transform:rotate(2deg) scale(1.06);}\n" +
    ".net-btn.net-primary{background:var(--color-fushia,#5cff5c);}\n" +
    ".net-btn.net-ghost{background:transparent;color:#fff;box-shadow:none;opacity:.85;}\n" +
    ".net-code{display:flex;gap:8px;}\n" +
    ".net-code span{display:inline-flex;align-items:center;justify-content:center;width:52px;height:64px;\n" +
    "  background:#fff;border:3px solid #000;border-radius:10px;font-size:34px;color:#204a78;box-shadow:4px 4px 0 #000;}\n" +
    ".net-input{font-family:var(--font-bangers);font-size:34px;letter-spacing:.3em;text-align:center;text-transform:uppercase;\n" +
    "  width:280px;padding:12px 8px 8px;border:3px solid #000;border-radius:12px;box-shadow:4px 4px 0 #000;color:#204a78;}\n" +
    ".net-input.net-shake{animation:net-shake .3s;}\n" +
    "@keyframes net-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-8px);}75%{transform:translateX(8px);}}\n" +
    ".net-dots::after{content:'';animation:net-dots 1.2s steps(4) infinite;}\n" +
    "@keyframes net-dots{0%{content:'';}25%{content:'.';}50%{content:'..';}75%{content:'...';}}\n" +
    ".net-toast{position:fixed;top:26px;left:50%;transform:translateX(-50%);z-index:var(--z-over,1000);\n" +
    "  background:#204a78;color:#fff;font-family:var(--font-bangers);font-size:18px;padding:12px 24px 9px;\n" +
    "  border:3px solid #000;border-radius:999px;box-shadow:5px 5px 0 #000;text-transform:uppercase;}\n";

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    injectStyle();
    overlayEl = el("div", { class: "net-overlay" });
    document.body.appendChild(overlayEl);
    return overlayEl;
  }
  function removeOverlay() {
    if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
  }
  function renderCard(children) {
    var o = ensureOverlay();
    o.innerHTML = "";
    var card = el("div", { class: "net-card" });
    for (var i = 0; i < children.length; i++) card.appendChild(children[i]);
    o.appendChild(card);
    return card;
  }

  function showToast(msg) {
    var t = el("div", { class: "net-toast" }, msg);
    document.body.appendChild(t);
    var anim = t.animate([{ opacity: 0, transform: "translate(-50%,-12px)" }, { opacity: 1, transform: "translate(-50%,0)" }], { duration: 250, easing: "cubic-bezier(.17,.89,.32,1.27)" });
    setTimeout(function () {
      var out = t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
      out.finished.catch(function () {}).then(function () { if (t.parentNode) t.parentNode.removeChild(t); });
    }, 2200);
  }

  function screenError(title, body, retry, back) {
    var h = el("div", { class: "net-h" }, title);
    var p = el("div", { class: "net-p" }, body);
    var row = el("div", { class: "net-row" });
    var b1 = el("button", { class: "net-btn net-primary", type: "button" }, "TRY AGAIN");
    b1.onclick = function () { sfx("UI_cta"); retry(); };
    var b2 = el("button", { class: "net-btn net-ghost net-b", type: "button" }, "BACK");
    b2.onclick = function () { sfx("UI_cta"); back(); };
    row.appendChild(b1); row.appendChild(b2);
    renderCard([h, p, row]);
  }

  function lobby(opts) {
    opts = opts || {};
    gameKind = opts.mode === "c4" ? "c4" : "xo";
    moveCount = 0; rematchNo = 0; pendingReady = null; connected = false;
    return new Promise(function (resolve, reject) {
      lobbyReject = reject;

      function fail(code, title, body) {
        var err = new Error(code); err.code = code;
        // don't auto-reject on recoverable screens; only on explicit BACK
      }

      function toChoose() {
        var h = el("div", { class: "net-h" }, "ONLINE PLAY");
        var row = el("div", { class: "net-row" });
        var bHost = el("button", { class: "net-btn net-primary", type: "button" }, "HOST A GAME");
        bHost.onclick = function () { sfx("UI_cta"); toHosting(); };
        var bJoin = el("button", { class: "net-btn net-b", type: "button" }, "JOIN A GAME");
        bJoin.onclick = function () { sfx("UI_cta"); toJoinInput(); };
        row.appendChild(bHost); row.appendChild(bJoin);
        var back = el("button", { class: "net-btn net-ghost", type: "button" }, "BACK");
        back.onclick = function () { sfx("UI_cta"); teardownRoom(); removeOverlay(); reject(Object.assign(new Error("cancelled"), { code: "cancelled" })); };
        renderCard([h, row, back]);
      }

      function toHosting() {
        var code = genCode();
        var h = el("div", { class: "net-h" }, "HOSTING");
        var codeRow = el("div", { class: "net-code" });
        for (var i = 0; i < code.length; i++) codeRow.appendChild(el("span", {}, code[i]));
        var p = el("div", { class: "net-p net-dots" }, "WAITING FOR PLAYER");
        var row = el("div", { class: "net-row" });
        var bCopyLink = el("button", { class: "net-btn net-primary", type: "button" }, "COPY LINK");
        bCopyLink.onclick = function () {
          sfx("UI_cta");
          var link = location.origin + location.pathname + "?join=" + code;
          (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(link) : Promise.reject()).catch(function () {}).then(function () {
            bCopyLink.textContent = "COPIED!"; setTimeout(function () { bCopyLink.textContent = "COPY LINK"; }, 1200);
          });
        };
        var bCopyCode = el("button", { class: "net-btn net-b", type: "button" }, "COPY CODE");
        bCopyCode.onclick = function () {
          sfx("UI_cta");
          (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(code) : Promise.reject()).catch(function () {}).then(function () {
            bCopyCode.textContent = "COPIED!"; setTimeout(function () { bCopyCode.textContent = "COPY CODE"; }, 1200);
          });
        };
        row.appendChild(bCopyLink); row.appendChild(bCopyCode);
        var cancel = el("button", { class: "net-btn net-ghost", type: "button" }, "CANCEL");
        renderCard([h, codeRow, p, row, cancel]);

        var settled = false;
        var hostTimer = setTimeout(function () {
          if (settled) return; settled = true; teardownRoom();
          screenError("NOBODY JOINED", "THE CODE MAY HAVE EXPIRED.", toHosting, toChoose);
        }, HOST_WAIT_MS);
        cancel.onclick = function () { settled = true; clearTimeout(hostTimer); sfx("UI_cta"); teardownRoom(); toChoose(); };

        joinErrorCb = function () {
          if (settled) return; settled = true; clearTimeout(hostTimer);
          screenError("CONNECTION FAILED", "COULDN'T REACH THE MATCHMAKING NETWORK. TRY AGAIN.", toHosting, toChoose);
        };

        openRoom(code, "host").then(function () {
          room.onPeerJoin = function (pid) {
            // This "already full" check must run regardless of `settled` — it
            // has to keep rejecting later joiners even after our own first
            // peer has already connected and the lobby has moved on.
            if (Object.keys(room.getPeers()).length > 1) {
              try { actions.ctl.send({ k: "full" }, { target: pid }); } catch (e) {}
              return;
            }
            if (settled) return;
            settled = true; clearTimeout(hostTimer);
            peerId = pid;
            firstIsHost = true;
            toConnecting(code);
          };
        }).catch(function (e) {
          if (settled) return; settled = true; clearTimeout(hostTimer);
          var code2 = e && e.code === "offline" ? "offline" : e && e.code === "libload" ? "libload" : "signal";
          showLibError(code2, toHosting, toChoose);
        });
      }

      function toJoinInput() {
        var h = el("div", { class: "net-h" }, "JOIN A GAME");
        var input = el("input", { class: "net-input", maxlength: String(CODE_LEN), placeholder: "CODE" });
        input.addEventListener("input", function () {
          input.value = input.value.toUpperCase().replace(new RegExp("[^" + CODE_ALPHABET + "]", "g"), "").slice(0, CODE_LEN);
        });
        var row = el("div", { class: "net-row" });
        var bGo = el("button", { class: "net-btn net-primary", type: "button" }, "CONNECT");
        var bBack = el("button", { class: "net-btn net-ghost net-b", type: "button" }, "BACK");
        bBack.onclick = function () { sfx("UI_cta"); toChoose(); };
        row.appendChild(bGo); row.appendChild(bBack);
        var card = renderCard([h, input, row]);
        input.focus();

        function submit() {
          var code = input.value.trim();
          if (code.length !== CODE_LEN) {
            sfx("UI_transition-shake");
            input.classList.remove("net-shake"); void input.offsetWidth; input.classList.add("net-shake");
            return;
          }
          sfx("UI_cta");
          toJoining(code);
        }
        bGo.onclick = submit;
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });

        if (pendingJoinCode) {
          input.value = pendingJoinCode; pendingJoinCode = null;
          submit();
        }
      }

      function toJoining(code) {
        var h = el("div", { class: "net-h net-dots" }, "CONNECTING");
        var back = el("button", { class: "net-btn net-ghost", type: "button" }, "BACK");
        renderCard([h, back]);

        var settled = false;
        back.onclick = function () { settled = true; clearTimeout(guestTimer); sfx("UI_cta"); teardownRoom(); toChoose(); };

        var guestTimer = setTimeout(function () {
          if (settled) return; settled = true; teardownRoom();
          screenError("NOBODY THERE", "CHECK THE CODE, OR ASK YOUR FRIEND TO HOST AGAIN.", function () { toJoining(code); }, toChoose);
        }, GUEST_WAIT_MS);

        joinErrorCb = function () {
          if (settled) return; settled = true; clearTimeout(guestTimer);
          screenError("COULDN'T CONNECT", "COULDN'T MAKE A DIRECT CONNECTION. YOUR TWO NETWORKS DON'T ALLOW IT. TRY A DIFFERENT WI-FI, OR PLAY 2 PLAYERS ON ONE DEVICE.", function () { toJoining(code); }, toChoose);
        };

        fullCb = function () {
          if (settled) return; settled = true; clearTimeout(guestTimer);
          teardownRoom();
          screenError("ROOM FULL", "THAT GAME IS ALREADY FULL.", toChoose, toChoose);
        };

        openRoom(code, "guest").then(function () {
          room.onPeerJoin = function (pid) {
            if (Object.keys(room.getPeers()).length > 1) {
              try { actions.ctl.send({ k: "full" }, { target: pid }); } catch (e) {}
              return;
            }
            if (settled) return;
            settled = true; clearTimeout(guestTimer);
            peerId = pid;
            toConnecting(code);
          };
        }).catch(function (e) {
          if (settled) return; settled = true; clearTimeout(guestTimer);
          var code2 = e && e.code === "offline" ? "offline" : e && e.code === "libload" ? "libload" : "signal";
          showLibError(code2, function () { toJoining(code); }, toChoose);
        });
      }

      function toConnecting(code) {
        var h = el("div", { class: "net-h net-dots" }, "CONNECTING");
        renderCard([h]);

        var settled = false;
        var helloTimer = setTimeout(function () {
          if (settled) return; settled = true; teardownRoom();
          screenError("CONNECTION LOST", "YOUR OPPONENT DISAPPEARED BEFORE THE GAME COULD START.", function () { role === "host" ? toHosting() : toJoinInput(); }, toChoose);
        }, HELLO_WAIT_MS);

        room.onPeerLeave = function () {
          if (settled) return; settled = true; clearTimeout(helloTimer);
          teardownRoom();
          screenError("OPPONENT LEFT", "TRY AGAIN?", function () { role === "host" ? toHosting() : toJoinInput(); }, toChoose);
        };

        var myHello = { v: PROTO, role: role, game: gameKind, avatar: validAvatar(opts.avatar), firstIsHost: role === "host" ? true : firstIsHost };
        var gotTheirs = false, sentMine = false;
        actions.hello.onMessage = function (msg, meta) {
          if (settled) return;
          if (!fromAcceptedPeer(meta)) return;
          if (!msg || msg.v !== PROTO) {
            settled = true; clearTimeout(helloTimer); teardownRoom();
            screenError("VERSION MISMATCH", "ONE OF YOU HAS AN OLDER COPY OF THE PAGE. RELOAD.", function () { location.reload(); }, toChoose);
            return;
          }
          if (msg.role === role) {
            settled = true; clearTimeout(helloTimer); teardownRoom();
            screenError("ROOM IS BUSY", "TRY A NEW CODE.", toChoose, toChoose);
            return;
          }
          gotTheirs = true;
          peerAvatar = validAvatar(msg.avatar);
          // Host's value wins for both fields: only adopt the peer's claim when
          // *I* am the guest (i.e. the incoming message is from the host). If
          // I'm the host, my own already-set values stand unconditionally.
          if (role === "guest") {
            gameKind = msg.game === "c4" ? "c4" : "xo";
            firstIsHost = !!msg.firstIsHost;
          }
          if (sentMine) finish();
        };
        try { actions.hello.send(myHello); sentMine = true; } catch (e) {}
        if (sentMine && gotTheirs) finish();

        function finish() {
          settled = true; clearTimeout(helloTimer);
          connected = true;
          // Switch from the lobby's "connection failed to establish" handler
          // to the durable in-game one — from here on, losing the peer means
          // a forfeit, not a failed handshake.
          room.onPeerLeave = onPeerGone;
          sfx("EVENT_opponent");
          var h2 = el("div", { class: "net-h" }, "CONNECTED!");
          renderCard([h2]);
          setTimeout(function () {
            removeOverlay();
            lobbyReject = null;
            resolve({
              role: role,
              mode: gameKind,
              side: gameKind === "c4" ? c4Side() : (xoSide() === "X" ? 1 : 2),
              firstIsHost: firstIsHost,
              opponent: { id: -1, name: "RIVAL", role: "", avatar: peerAvatar, opponentId: "rival" }
            });
          }, 650);
        }
      }

      function showLibError(code, retry, back) {
        if (code === "offline") screenError("YOU'RE OFFLINE", "ONLINE PLAY NEEDS AN INTERNET CONNECTION.", retry, back);
        else if (code === "libload") screenError("COULDN'T LOAD THE NETWORK LIBRARY", "CHECK YOUR CONNECTION AND TRY AGAIN.", retry, back);
        else screenError("CONNECTION FAILED", "COULDN'T REACH THE MATCHMAKING NETWORK. TRY AGAIN.", retry, back);
      }

      if (pendingJoinCode) toJoinInput();
      else toChoose();
    });
  }

  /* ------------------------------------------------------------------ *
   *  Rematch — reuse the live room instead of a full lobby.
   * ------------------------------------------------------------------ */
  function rematch(opts) {
    opts = opts || {};
    if (!isConnected()) return lobby(opts);
    gameKind = opts.mode === "c4" ? "c4" : gameKind;
    moveCount = 0;
    return new Promise(function (resolve, reject) {
      rematchReject = reject;
      var h = el("div", { class: "net-h" }, "REMATCH?");
      var p = el("div", { class: "net-p" }, "PLAY AGAIN WITH THE SAME OPPONENT.");
      var row = el("div", { class: "net-row" });
      var bReady = el("button", { class: "net-btn net-primary", type: "button" }, "READY");
      var bBack = el("button", { class: "net-btn net-ghost net-b", type: "button" }, "BACK TO MENU");
      row.appendChild(bReady); row.appendChild(bBack);
      renderCard([h, p, row]);

      bBack.onclick = function () {
        sfx("UI_cta");
        try { actions.ctl.send({ k: "bye" }); } catch (e) {}
        if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; }
        teardownRoom(); removeOverlay(); rematchReject = null;
        reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));
      };

      var myReady = false, theirReady = null;
      rematchNo++;
      var myR = rematchNo;
      var nextFirstIsHost = !firstIsHost; // alternate first-move advantage
      rematchResolve = function (msg) {
        if (!msg || msg.r !== myR) return;
        theirReady = msg;
        maybeFinish();
      };
      if (pendingReady) {
        var earlyReady = pendingReady;
        pendingReady = null;
        rematchResolve(earlyReady);
      }
      rematchTimer = setTimeout(function () {
        if (!rematchReject) return;
        rematchResolve = null;
        var rejectRematch = rematchReject;
        rematchReject = null;
        removeOverlay(); teardownRoom();
        rejectRematch(Object.assign(new Error("rematch-timeout"), { code: "rematch-timeout" }));
      }, REMATCH_WAIT_MS);
      bReady.onclick = function () {
        sfx("UI_cta");
        myReady = true;
        bReady.textContent = "WAITING FOR OPPONENT…";
        bReady.disabled = true;
        try { actions.ctl.send({ k: "ready", r: myR, firstIsHost: role === "host" ? nextFirstIsHost : firstIsHost }); } catch (e) {}
        maybeFinish();
      };

      function maybeFinish() {
        if (!myReady || !theirReady) return;
        if (rematchTimer) { clearTimeout(rematchTimer); rematchTimer = null; }
        rematchResolve = null; rematchReject = null;
        firstIsHost = role === "host" ? nextFirstIsHost : !!theirReady.firstIsHost;
        removeOverlay();
        resolve({
          role: role,
          mode: gameKind,
          side: gameKind === "c4" ? c4Side() : (xoSide() === "X" ? 1 : 2),
          firstIsHost: firstIsHost,
          opponent: { id: -1, name: "RIVAL", role: "", avatar: peerAvatar, opponentId: "rival" }
        });
      }
    });
  }

  /* ------------------------------------------------------------------ *
   *  Public bridge
   * ------------------------------------------------------------------ */
  window.__net = {
    available: true,
    lobby: lobby,
    rematch: rematch,
    sendMoveIndex: sendMoveIndex,
    onMove: onMove,
    onLost: onLost,
    isConnected: isConnected,
    leave: function () { teardownRoom(); },
    xoSide: xoSide,
    c4Side: c4Side,
    role: null
  };
  Object.defineProperty(window.__net, "role", { get: function () { return role; } });
})();
