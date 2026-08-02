/* Connect Four mode for the XOX clone.
 * Classic (non-module) script — loads BEFORE the Vue/WebGL bundle and exposes
 * window.__c4. All rendering is DOM+CSS (no WebGL), styled with the site's own
 * CSS custom properties (--color-*, --ease-*, --font-bangers) so it matches the
 * site without any build step.
 *
 * API:
 *   window.__c4.mode            "xo" | "c4"  (get/set)
 *   window.__c4.pickerHTML()    markup for the welcome-screen mode picker
 *   window.__c4.play(opts)      Promise<"win"|"lose"|"draw"> — plays a full game
 *   window.__c4.unmount()       idempotent teardown of the board overlay
 *
 * opts for play(): { opponent, sfx, colors, results, setClearColor }
 * (sfx/colors/results are also reachable via window.__xoxBridge as a fallback.)
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   *  Constants & rules
   * ------------------------------------------------------------------ */
  var COLS = 7, ROWS = 6, EMPTY = 0, HUMAN = 1, CPU = 2;
  var MOVE_ORDER = [3, 2, 4, 1, 5, 0, 6]; // center-biased
  // AI strength per difficulty tier — DEPTH is the negamax search depth, BLUNDER is the
  // chance the AI deliberately plays the 2nd-best move instead of the best one it found.
  // "hard" is genuinely strong: full alpha-beta at depth 7 with zero blunder chance —
  // it will find and take forced wins and will not miss blocks a shallower/blundering
  // search would miss.
  var AI_TIERS = {
    easy: { depth: 2, blunder: 0.45 },
    medium: { depth: 4, blunder: 0.25 },
    hard: { depth: 9, blunder: 0 }
  };
  var DEPTH = AI_TIERS.medium.depth;      // AI search depth — set per-game from `difficulty`
  var BLUNDER = AI_TIERS.medium.blunder;  // chance the AI plays 2nd-best move
  var THINK_MIN = 700, THINK_SPREAD = 700; // ~1.1s average CPU "thinking" pause
  var BOARD_TILT = -1.5;                  // deg — comic-panel tilt of the panel

  // The 69 possible 4-in-a-row windows (24 horiz + 21 vert + 12 + 12 diag).
  // Board index: row * COLS + col, row 0 = BOTTOM row.
  var WINDOWS = (function () {
    var ws = [];
    var r, c, i;
    for (r = 0; r < ROWS; r++)            // horizontal
      for (c = 0; c <= COLS - 4; c++) {
        var w = [];
        for (i = 0; i < 4; i++) w.push(r * COLS + c + i);
        ws.push(w);
      }
    for (c = 0; c < COLS; c++)            // vertical
      for (r = 0; r <= ROWS - 4; r++) {
        var w2 = [];
        for (i = 0; i < 4; i++) w2.push((r + i) * COLS + c);
        ws.push(w2);
      }
    for (c = 0; c <= COLS - 4; c++)       // diagonal up-right
      for (r = 0; r <= ROWS - 4; r++) {
        var w3 = [];
        for (i = 0; i < 4; i++) w3.push((r + i) * COLS + (c + i));
        ws.push(w3);
      }
    for (c = 0; c <= COLS - 4; c++)       // diagonal down-right
      for (r = 3; r < ROWS; r++) {
        var w4 = [];
        for (i = 0; i < 4; i++) w4.push((r - i) * COLS + (c + i));
        ws.push(w4);
      }
    return ws;
  })();

  function newBoard() { var b = []; for (var i = 0; i < COLS * ROWS; i++) b.push(EMPTY); return b; }

  // Returns { player, cells:[i,i,i,i] } or null.
  function findWin(b) {
    for (var k = 0; k < WINDOWS.length; k++) {
      var w = WINDOWS[k], v = b[w[0]];
      if (v !== EMPTY && v === b[w[1]] && v === b[w[2]] && v === b[w[3]])
        return { player: v, cells: w };
    }
    return null;
  }

  function legalMoves(b) {
    var ms = [];
    for (var k = 0; k < MOVE_ORDER.length; k++) {
      var c = MOVE_ORDER[k];
      if (b[(ROWS - 1) * COLS + c] === EMPTY) ms.push(c);
    }
    return ms;
  }

  // Drops a disc into column col of board b (mutates). Returns row, or -1 if full.
  function dropInto(b, col, player) {
    for (var r = 0; r < ROWS; r++) {
      var i = r * COLS + col;
      if (b[i] === EMPTY) { b[i] = player; return r; }
    }
    return -1;
  }

  /* ------------------------------------------------------------------ *
   *  AI — minimax + alpha-beta, depth-limited, with a deliberate blunder
   *  mechanic so it feels like the site's tic-tac-toe opponent: alert but
   *  occasionally fallible, never clairvoyant.
   * ------------------------------------------------------------------ */
  var INF = 1e9;

  function evaluate(b) { // heuristic, from AI's perspective
    var score = 0, k, i;
    for (k = 0; k < WINDOWS.length; k++) {
      var w = WINDOWS[k], ai = 0, hu = 0;
      for (i = 0; i < 4; i++) {
        var v = b[w[i]];
        if (v === CPU) ai++; else if (v === HUMAN) hu++;
      }
      if (ai && hu) continue;              // dead window
      if (ai === 2) score += 1; else if (ai === 3) score += 5;
      if (hu === 2) score -= 1; else if (hu === 3) score -= 8; // defense weighted higher
    }
    for (i = 0; i < ROWS; i++) {           // center-column control
      var cv = b[i * COLS + 3];
      if (cv === CPU) score += 3; else if (cv === HUMAN) score -= 3;
    }
    return score;
  }

  function search(b, depth, alpha, beta, maximizing, ply) {
    var w = findWin(b);
    if (w) return w.player === CPU ? 100000 - ply : ply - 100000;
    var moves = legalMoves(b);
    if (!moves.length || depth === 0) return evaluate(b);
    var k, bb, v;
    if (maximizing) {
      v = -INF;
      for (k = 0; k < moves.length; k++) {
        bb = b.slice(); dropInto(bb, moves[k], CPU);
        v = Math.max(v, search(bb, depth - 1, alpha, beta, false, ply + 1));
        alpha = Math.max(alpha, v);
        if (alpha >= beta) break;
      }
      return v;
    }
    v = INF;
    for (k = 0; k < moves.length; k++) {
      bb = b.slice(); dropInto(bb, moves[k], HUMAN);
      v = Math.min(v, search(bb, depth - 1, alpha, beta, true, ply + 1));
      beta = Math.min(beta, v);
      if (alpha >= beta) break;
    }
    return v;
  }

  function givesImmediateWin(b, col, player) {
    var bb = b.slice();
    dropInto(bb, col, player);
    var w = findWin(bb);
    return !!w && w.player === player;
  }

  function chooseMove(b) {
    var moves = legalMoves(b), k;
    // 1) an immediate win is ALWAYS taken, never blundered away
    for (k = 0; k < moves.length; k++)
      if (givesImmediateWin(b, moves[k], CPU)) return moves[k];
    // 2) score every legal move
    var scored = [];
    for (k = 0; k < moves.length; k++) {
      var bb = b.slice(); dropInto(bb, moves[k], CPU);
      scored.push({ c: moves[k], s: search(bb, DEPTH - 1, -INF, INF, false, 1) });
    }
    scored.sort(function (a, z) { return z.s - a.s; });
    // 3) occasional blunder (~25%): play the SECOND-best move instead — this is
    //    where the AI's fallibility comes from (missed blocks, handed setups),
    //    mirroring the tic-tac-toe AI's deliberate 20% block-miss rate.
    if (scored.length > 1 && Math.random() < BLUNDER) return scored[1].c;
    return scored[0].c;
  }

  /* ------------------------------------------------------------------ *
   *  Sound bridge (bundle-private sfx function, exposed via __xoxBridge)
   * ------------------------------------------------------------------ */
  function sfx(name) {
    try {
      var b = window.__xoxBridge;
      if (b && b.sfx) b.sfx(name);
    } catch (e) { /* audio not ready — fine */ }
  }

  /* ------------------------------------------------------------------ *
   *  Styles (injected once at script load so the welcome picker is styled
   *  immediately). Everything references the site's own custom properties.
   * ------------------------------------------------------------------ */
  var CSS = `
/* ---- mode picker (welcome screen) ---- */
.c4-picker-host{position:relative;z-index:1;pointer-events:none;display:flex;justify-content:center;}
.c4-pickwrap{display:flex;flex-direction:column;gap:14px;align-items:center;}
.c4-step{display:flex;flex-direction:column;align-items:center;gap:16px;}
.c4-step-title{font-family:var(--font-bangers);text-transform:uppercase;color:#fff;
  font-size:clamp(22px,3.4vw,36px);letter-spacing:.03em;line-height:1;transform:rotate(-2deg);
  text-shadow:2px 2px 0 #000,-2px 2px 0 #000,2px -2px 0 #000,-2px -2px 0 #000;
  pointer-events:none;animation:c4-picker-in .5s var(--ease-out-back) backwards;}
.c4-picker{display:flex;gap:22px;align-items:center;justify-content:center;pointer-events:none;
  animation:c4-picker-in .55s var(--ease-out-back) 1.3s backwards;}
.c4-picker2{animation-delay:0s;}
.c4-picker2 .c4-opt{font-size:clamp(14px,1.8vw,20px);padding:8px 18px 6px;letter-spacing:.02em;}
.c4-back{position:fixed;top:28px;left:28px;z-index:50;pointer-events:none;
  animation:c4-picker-in .4s var(--ease-out-back) backwards;}
.c4-backbtn{pointer-events:auto;cursor:pointer;border:3px solid #000;border-radius:999px;background:#fff;
  font-family:var(--font-bangers);text-transform:uppercase;color:#204a78;
  font-size:clamp(16px,2vw,20px);letter-spacing:.03em;line-height:1;padding:10px 22px 8px;
  box-shadow:5px 5px 0 #000;transform:rotate(-3deg);
  transition:transform .15s var(--ease-out-back),box-shadow .15s;}
.c4-backbtn:hover{transform:rotate(-3deg) scale(1.08);}
.c4-summary{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:8px;
  animation:c4-picker-in .5s var(--ease-out-back) backwards;}
.c4-summary-chips{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;pointer-events:none;}
.c4-chip{display:inline-block;background:#fff;border:3px solid #000;border-radius:999px;
  padding:6px 16px 4px;box-shadow:4px 4px 0 #000;font-family:var(--font-bangers);
  text-transform:uppercase;color:#204a78;font-size:clamp(13px,1.8vw,17px);letter-spacing:.02em;
  line-height:1.2;}
.c4-chip-accent{background:var(--color-fushia);color:#fff;}
.c4-opt{pointer-events:auto;cursor:pointer;border:3px solid #000;border-radius:999px;background:#fff;
  font-family:var(--font-bangers);text-transform:uppercase;color:#fff;
  font-size:clamp(18px,2.4vw,28px);letter-spacing:.04em;line-height:1;padding:10px 26px 8px;
  -webkit-text-stroke:1.5px #000;paint-order:stroke fill;
  text-shadow:2px 2px 0 #000,-2px 2px 0 #000,2px -2px 0 #000,-2px -2px 0 #000;
  box-shadow:5px 5px 0 #000;opacity:.72;transform:rotate(-3deg);
  transition:transform .18s var(--ease-out-back),box-shadow .18s,opacity .18s,background-color .18s;}
.c4-opt.c4-opt-b{transform:rotate(3deg);}
.c4-opt:hover{opacity:.95;transform:rotate(-3deg) scale(1.06);}
.c4-opt.c4-opt-b:hover{transform:rotate(3deg) scale(1.06);}
.c4-opt.is-sel{background:var(--color-fushia);opacity:1;box-shadow:7px 7px 0 #000;transform:rotate(-3deg) scale(1.09);}
.c4-opt.c4-opt-b.is-sel{transform:rotate(3deg) scale(1.09);}
@keyframes c4-picker-in{from{opacity:0;transform:translateY(34px) scale(.6);}to{opacity:1;transform:none;}}

/* ---- game overlay root ---- */
.c4-root{position:fixed;inset:0;z-index:var(--z-ui);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:26px;pointer-events:none;}

/* ---- turn label ---- */
.c4-turn{font-family:var(--font-bangers);text-transform:uppercase;letter-spacing:.05em;line-height:1;
  font-size:clamp(30px,5vw,54px);color:#fff;
  text-shadow:2px 2px 0 #000,-2px 2px 0 #000,2px -2px 0 #000,-2px -2px 0 #000;}
.c4-turn.c4-cpu{color:var(--color-cyan);}

/* ---- CPU taunt speech bubble ---- */
.c4-taunt{position:absolute;top:-96px;left:50%;transform:translate(-50%,-100%) scale(.6);
  max-width:min(74vw,420px);width:max-content;background:#fff;color:#204a78;
  font-family:var(--font-bangers);font-size:clamp(15px,2vw,19px);line-height:1.15;
  text-align:center;padding:10px 16px 8px;border:3px solid #000;border-radius:16px;
  box-shadow:5px 5px 0 #000;opacity:0;pointer-events:none;z-index:5;}
.c4-taunt::after{content:'';position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);
  border:8px solid transparent;border-top-color:#000;}
.c4-taunt::before{content:'';position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);
  border:7px solid transparent;border-top-color:#fff;z-index:1;}

/* ---- board panel ---- */
.c4-board{position:relative;display:flex;gap:var(--c4-gap);padding:var(--c4-pad);
  background:var(--color-blue);border:4px solid #000;border-radius:calc(var(--c4-cell)*.22);
  box-shadow:10px 12px 0 rgba(0,0,0,.85);transform:rotate(${BOARD_TILT}deg);pointer-events:auto;}
.c4-col{display:flex;flex-direction:column-reverse;gap:var(--c4-gap);
  border-radius:calc(var(--c4-cell)*.5);transition:background-color .15s;}
.c4-col.c4-hover{background:rgba(255,255,255,.09);}
.c4-col.c4-shake{animation:c4-shake .3s;}
.c4-cell{width:var(--c4-cell);height:var(--c4-cell);border-radius:50%;
  background:var(--color-blue-dark);box-shadow:inset 0 3px 6px rgba(0,0,0,.6);
  animation:c4-cell-in .45s var(--ease-out-back) backwards;}
@keyframes c4-cell-in{from{transform:scale(.35);opacity:0;}to{transform:scale(1);opacity:1;}}
@keyframes c4-shake{0%,100%{transform:translateX(0);}25%{transform:translateX(-5px);}75%{transform:translateX(5px);}}

/* ---- discs / ghost / fx layers ---- */
.c4-discs,.c4-svg{position:absolute;inset:0;pointer-events:none;overflow:visible;}
.c4-svg{z-index:10;}
.c4-disc{position:absolute;width:var(--c4-cell);height:var(--c4-cell);border-radius:50%;
  background:transparent;border:none;box-shadow:none;}
.c4-disc.c4-win{border:4px solid #fff;box-shadow:0 0 0 3px #fff,0 0 0 6px #000;}
.c4-ghost{position:absolute;width:var(--c4-cell);height:var(--c4-cell);border-radius:50%;
  border:3px solid rgba(0,0,0,.6);background:var(--color-fushia);opacity:.55;pointer-events:none;
  transition:left .12s var(--ease-smooth),top .12s var(--ease-smooth);
  animation:c4-bob .9s ease-in-out infinite alternate;}
@keyframes c4-bob{from{transform:translateY(0);}to{transform:translateY(-6px);}}
.c4-flash{position:absolute;width:var(--c4-cell);height:var(--c4-cell);border-radius:50%;
  border:4px solid #fff;pointer-events:none;}

/* ---- end states ---- */
.c4-root.c4-dim .c4-disc{filter:saturate(.25) brightness(.8);opacity:.5;transition:filter .4s,opacity .4s;}
.c4-root.c4-dim .c4-disc.c4-win{filter:none;opacity:1;}
.c4-disc.c4-win{animation:c4-winpulse .5s ease-in-out infinite alternate;z-index:6;}
@keyframes c4-winpulse{
  from{transform:scale(1);box-shadow:0 0 0 3px #fff,0 0 0 6px #000,inset 0 -6px 0 rgba(0,0,0,.22);}
  to{transform:scale(1.1);box-shadow:0 0 0 5px #fff,0 0 0 9px #000,inset 0 -6px 0 rgba(0,0,0,.22);}}
.c4-root.c4-draw .c4-disc{filter:saturate(.2) brightness(.85);transition:filter .5s;}
`;

  function injectStyle() {
    if (document.getElementById("c4-style")) return;
    var st = document.createElement("style");
    st.id = "c4-style";
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------------ *
   *  Mode picker (welcome screen). Rendered as static HTML injected by the
   *  bundle; all interactivity lives here via delegated listeners so Vue
   *  never has to re-render it.
   * ------------------------------------------------------------------ */
  var mode = "xo";
  var players = "1p";
  var difficulty = "medium";
  // Sequential wizard: "game" -> "players" -> ("difficulty" only if VS CPU) -> "done".
  var step = "game";
  function setStep(s) {
    step = s;
    try { window.dispatchEvent(new CustomEvent("xox-step", { detail: step })); } catch (e) { /* noop */ }
  }

  function gameOptsHTML() {
    return '<button type="button" class="c4-opt' + (mode === "xo" ? " is-sel" : "") + '" data-c4-mode="xo" role="radio" aria-checked="' + (mode === "xo") + '">XO</button>'
      + '<button type="button" class="c4-opt c4-opt-b' + (mode === "c4" ? " is-sel" : "") + '" data-c4-mode="c4" role="radio" aria-checked="' + (mode === "c4") + '">CONNECT 4</button>';
  }
  function playersOptsHTML() {
    return '<button type="button" class="c4-opt' + (players === "1p" ? " is-sel" : "") + '" data-c4-players="1p" role="radio" aria-checked="' + (players === "1p") + '">VS CPU</button>'
      + '<button type="button" class="c4-opt' + (players === "local2p" ? " is-sel" : "") + '" data-c4-players="local2p" role="radio" aria-checked="' + (players === "local2p") + '">2 PLAYERS</button>'
      + '<button type="button" class="c4-opt c4-opt-b' + (players === "online" ? " is-sel" : "") + '" data-c4-players="online" role="radio" aria-checked="' + (players === "online") + '">ONLINE</button>';
  }
  function difficultyOptsHTML() {
    return '<button type="button" class="c4-opt' + (difficulty === "easy" ? " is-sel" : "") + '" data-c4-difficulty="easy" role="radio" aria-checked="' + (difficulty === "easy") + '">EASY</button>'
      + '<button type="button" class="c4-opt' + (difficulty === "medium" ? " is-sel" : "") + '" data-c4-difficulty="medium" role="radio" aria-checked="' + (difficulty === "medium") + '">MEDIUM</button>'
      + '<button type="button" class="c4-opt c4-opt-b' + (difficulty === "hard" ? " is-sel" : "") + '" data-c4-difficulty="hard" role="radio" aria-checked="' + (difficulty === "hard") + '">HARD</button>';
  }
  function summaryChips() {
    var g = mode === "c4" ? "CONNECT 4" : "XO";
    var chips = [g];
    if (players === "local2p") chips.push("2 PLAYERS");
    else if (players === "online") chips.push("ONLINE");
    else { chips.push("VS CPU"); chips.push(difficulty.toUpperCase()); }
    return chips;
  }
  function summaryChipsHTML() {
    var chips = summaryChips();
    return chips.map(function (c, idx) {
      return '<span class="c4-chip' + (idx === chips.length - 1 && chips.length > 1 ? " c4-chip-accent" : "") + '">' + c + '</span>';
    }).join("");
  }

  function pickerHTML() {
    return '<div class="c4-pickwrap">'
      + '<div class="c4-back" data-step-row="back" style="display:' + (step === "players" || step === "difficulty" ? "" : "none") + '">'
      + '<button type="button" class="c4-backbtn" data-c4-back="1">‹ BACK</button>'
      + '</div>'
      + '<div class="c4-step" data-step-row="game" style="display:' + (step === "game" ? "" : "none") + '">'
      + '<div class="c4-step-title">Choose a game</div>'
      + '<div class="c4-picker" role="radiogroup" aria-label="Game mode">'
      + gameOptsHTML()
      + '</div>'
      + '</div>'
      + '<div class="c4-step" data-step-row="players" style="display:' + (step === "players" ? "" : "none") + '">'
      + '<div class="c4-step-title">Choose your opponent</div>'
      + '<div class="c4-picker c4-picker2" role="radiogroup" aria-label="Players">'
      + playersOptsHTML()
      + '</div>'
      + '</div>'
      + '<div class="c4-step" data-step-row="difficulty" style="display:' + (step === "difficulty" ? "" : "none") + '">'
      + '<div class="c4-step-title">Choose a difficulty</div>'
      + '<div class="c4-picker c4-picker2" role="radiogroup" aria-label="Difficulty">'
      + difficultyOptsHTML()
      + '</div>'
      + '</div>'
      + '<div class="c4-summary" data-step-row="done" style="display:' + (step === "done" ? "" : "none") + '">'
      + '<div class="c4-summary-chips">' + summaryChipsHTML() + '</div>'
      + '<button type="button" class="c4-backbtn" data-c4-change="1">‹ BACK</button>'
      + '</div>'
      + '</div>';
  }

  function refreshPicker() {
    var opts = document.querySelectorAll("[data-c4-mode]");
    for (var i = 0; i < opts.length; i++) {
      var sel = opts[i].getAttribute("data-c4-mode") === mode;
      opts[i].classList.toggle("is-sel", sel);
      opts[i].setAttribute("aria-checked", sel ? "true" : "false");
    }
    var popts = document.querySelectorAll("[data-c4-players]");
    for (var j = 0; j < popts.length; j++) {
      var psel = popts[j].getAttribute("data-c4-players") === players;
      popts[j].classList.toggle("is-sel", psel);
      popts[j].setAttribute("aria-checked", psel ? "true" : "false");
    }
    var dopts = document.querySelectorAll("[data-c4-difficulty]");
    for (var k = 0; k < dopts.length; k++) {
      var dsel = dopts[k].getAttribute("data-c4-difficulty") === difficulty;
      dopts[k].classList.toggle("is-sel", dsel);
      dopts[k].setAttribute("aria-checked", dsel ? "true" : "false");
    }
    var rows = document.querySelectorAll("[data-step-row]");
    for (var m = 0; m < rows.length; m++) {
      var row = rows[m], name = row.getAttribute("data-step-row");
      row.style.display = (name === "back") ? (step === "players" || step === "difficulty" ? "" : "none") : (name === step ? "" : "none");
      // Rows carry a long entrance-animation delay meant for the very first,
      // page-load reveal only (staggered with the rest of the welcome screen).
      // Any reveal from here on (wizard back-navigation, re-selecting a step)
      // is a direct response to a click, so it must animate in immediately.
      row.style.animationDelay = "0s";
    }
    var summaryEl = document.querySelector(".c4-summary-chips");
    if (summaryEl) summaryEl.innerHTML = summaryChipsHTML();
  }

  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest(".c4-opt, [data-c4-back], [data-c4-change]") : null;
    if (!t) return;
    if (t.hasAttribute("data-c4-back") || t.hasAttribute("data-c4-change")) {
      sfx("UI_cta");
      // Both "‹ BACK" and "CHANGE" step back exactly one screen in the wizard —
      // never a full restart — so from "done" the previous screen depends on
      // whether a difficulty step was actually shown for this players choice.
      if (step === "difficulty") setStep("players");
      else if (step === "done") setStep(players === "1p" ? "difficulty" : "players");
      else setStep("game");
      refreshPicker();
      return;
    }
    var m = t.getAttribute("data-c4-mode");
    if (m === "xo" || m === "c4") {
      mode = m;
      sfx("UI_cta");
      setStep("players");
      refreshPicker();
      return;
    }
    var p = t.getAttribute("data-c4-players");
    if (p === "1p" || p === "local2p" || p === "online") {
      players = p;
      sfx("UI_cta");
      setStep(p === "1p" ? "difficulty" : "done");
      refreshPicker();
      window.dispatchEvent(new CustomEvent("xox-players", { detail: players }));
      return;
    }
    var d = t.getAttribute("data-c4-difficulty");
    if (d === "easy" || d === "medium" || d === "hard") {
      difficulty = d;
      sfx("UI_cta");
      setStep("done");
      refreshPicker();
      return;
    }
  }, true);

  document.addEventListener("mouseover", function (e) {
    var t = e.target && e.target.closest ? e.target.closest(".c4-opt") : null;
    if (!t) return;
    if (e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".c4-opt") === t) return;
    sfx("UI_cta-hover");
  }, true);

  /* ------------------------------------------------------------------ *
   *  Board geometry — one number (cell) drives everything else.
   * ------------------------------------------------------------------ */
  var geom = null;

  function computeGeom() {
    var vw = window.innerWidth, vh = window.innerHeight;
    // width budget: viewport minus page margins, panel border, and tilt overhang
    // (the rotated panel's axis-aligned bounding box is wider than the panel itself)
    var cell = Math.min((vw - 88) / COLS, (vh - 250) / ROWS);
    cell = Math.max(34, Math.min(96, Math.floor(cell)));
    var gap = Math.max(6, Math.round(cell * 0.12));
    var pad = Math.round(cell * 0.18);
    return {
      cell: cell, gap: gap, pad: pad,
      w: pad * 2 + COLS * cell + (COLS - 1) * gap,
      h: pad * 2 + ROWS * cell + (ROWS - 1) * gap
    };
  }

  // Top-left of socket (col,row) within the board's content box, in px.
  function posOf(col, row) {
    return {
      x: geom.pad + col * (geom.cell + geom.gap),
      y: geom.pad + (ROWS - 1 - row) * (geom.cell + geom.gap)
    };
  }

  // The board panel has an opaque fill (and every cell has its own opaque circle on
  // top of that) — so a landed disc's real visual (a WebGL-rendered PQX face / Ys rig,
  // drawn on the canvas *behind* everything) needs an actual hole punched through the
  // panel, not just a transparent cell background (which would only reveal the panel's
  // own fill sitting right behind it). A CSS mask-image can cut real holes; a per-cell
  // background toggle cannot.
  function updateMask() {
    if (!boardEl) return;
    if (!occupiedSet.size) {
      boardEl.style.maskImage = boardEl.style.webkitMaskImage = "";
      return;
    }
    var d = "M0,0H" + geom.w + "V" + geom.h + "H0Z";
    occupiedSet.forEach(function (key) {
      var parts = key.split(","), col = +parts[0], row = +parts[1];
      var p = posOf(col, row);
      var cx = p.x + geom.cell / 2, cy = p.y + geom.cell / 2, r = geom.cell / 2 + 1;
      d += " M" + (cx - r) + "," + cy
        + " A" + r + "," + r + " 0 1 0 " + (cx + r) + "," + cy
        + " A" + r + "," + r + " 0 1 0 " + (cx - r) + "," + cy + "Z";
    });
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + geom.w + '" height="' + geom.h + '">'
      + '<path fill="#fff" fill-rule="evenodd" d="' + d + '"/></svg>';
    var url = 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
    boardEl.style.maskImage = url;
    boardEl.style.webkitMaskImage = url;
    boardEl.style.maskSize = boardEl.style.webkitMaskSize = geom.w + "px " + geom.h + "px";
    boardEl.style.maskRepeat = boardEl.style.webkitMaskRepeat = "no-repeat";
  }

  /* ------------------------------------------------------------------ *
   *  Game session state
   * ------------------------------------------------------------------ */
  var rootEl = null, boardEl = null, discLayer = null, svgEl = null, ghostEl = null, turnEl = null;
  var discEls = []; // live disc elements — polled each frame so the WebGL rigs (real
                     // 3D characters, not CSS-colored circles) can track their on-screen
                     // position, including mid-fall.
  var publishing = false;
  var occupiedSet = new Set(); // "col,row" keys currently punched through the panel mask
  var grid = null, colEls = null;
  var locked = false, over = false, hoverCol = -1;
  var thinkTimer = null, resolveRef = null, onResize = null;
  var pmode = "1p", mySide = 1, turn = 1; // pmode: "1p" | "local2p" | "online"
  var tauntEl = null, tauntTimer = null, tauntHideTo = null;
  var TAUNT_MIN = 6000, TAUNT_SPREAD = 6000; // matches the XO game's fact-bubble cadence
  var paused = false, pendingCpuMove = false;

  function setPaused(p) {
    if (!rootEl || paused === p) return;
    paused = p;
    if (p) {
      if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; pendingCpuMove = true; }
      stopTaunts();
    } else {
      if (pendingCpuMove) { pendingCpuMove = false; thinkTimer = setTimeout(cpuTurn, THINK_MIN + Math.random() * THINK_SPREAD); }
      if (pmode === "1p" && !over) scheduleTaunts();
    }
  }

  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ------------------------------------------------------------------ *
   *  CPU taunts — vs CPU only (mirrors the XO board's opponent "facts"),
   *  reusing the shared joke list on window.__xoxBridge so both games say
   *  the same lines rather than maintaining two separate copies.
   * ------------------------------------------------------------------ */
  function showTaunt() {
    if (!boardEl || over || pmode !== "1p") return;
    var list = (window.__xoxBridge && window.__xoxBridge.taunts) || [];
    if (!list.length) return;
    if (!tauntEl) {
      tauntEl = document.createElement("div");
      tauntEl.className = "c4-taunt";
      boardEl.appendChild(tauntEl);
    }
    clearTimeout(tauntHideTo);
    tauntEl.textContent = list[Math.floor(Math.random() * list.length)];
    tauntEl.getAnimations().forEach(function (a) { a.cancel(); });
    tauntEl.animate([
      { opacity: 0, transform: "translate(-50%,-100%) scale(.6)" },
      { opacity: 1, transform: "translate(-50%,-100%) scale(1)" }
    ], { duration: 300, easing: "cubic-bezier(.17,.89,.32,1.27)", fill: "forwards" });
    tauntHideTo = setTimeout(function () {
      if (!tauntEl) return;
      tauntEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, fill: "forwards" });
    }, 3500);
  }

  function scheduleTaunts() {
    stopTaunts();
    if (pmode !== "1p") return;
    tauntTimer = setTimeout(function () {
      showTaunt();
      scheduleTaunts();
    }, TAUNT_MIN + Math.random() * TAUNT_SPREAD);
  }

  function stopTaunts() {
    clearTimeout(tauntTimer); tauntTimer = null;
    clearTimeout(tauntHideTo); tauntHideTo = null;
    tauntEl = null; // boardEl (its parent) is torn down with the rest of the overlay
  }

  /* ------------------------------------------------------------------ *
   *  Mount / unmount
   * ------------------------------------------------------------------ */
  // Publishes live on-screen disc positions to window.__c4Discs every frame so the
  // bundle can render an actual PQX face-quad (player) / Ys avatar rig (CPU) at each
  // spot, in place of a flat colored circle — this is the DOM/CSS layer purely driving
  // positions+timing; the WebGL side reads them and does the real character rendering.
  function publishDiscs() {
    if (!rootEl) { window.__c4Discs = []; publishing = false; return; }
    var arr = [];
    for (var i = 0; i < discEls.length; i++) {
      var el = discEls[i];
      var r = el.getBoundingClientRect();
      var p = +el.getAttribute("data-player");
      arr.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, d: r.width, player: p, mine: p === mySide });
    }
    window.__c4Discs = arr;
    requestAnimationFrame(publishDiscs);
  }

  function mount() {
    geom = computeGeom();
    discEls = [];
    occupiedSet = new Set();
    window.__c4Discs = [];

    rootEl = document.createElement("div");
    rootEl.className = "c4-root";

    turnEl = document.createElement("div");
    turnEl.className = "c4-turn";
    turnEl.textContent = "YOUR TURN";
    rootEl.appendChild(turnEl);

    boardEl = document.createElement("div");
    boardEl.className = "c4-board";
    boardEl.style.setProperty("--c4-cell", geom.cell + "px");
    boardEl.style.setProperty("--c4-gap", geom.gap + "px");
    boardEl.style.setProperty("--c4-pad", geom.pad + "px");
    rootEl.appendChild(boardEl);

    colEls = [];
    for (var c = 0; c < COLS; c++) {
      var col = document.createElement("div");
      col.className = "c4-col";
      col.setAttribute("data-col", c);
      for (var r = 0; r < ROWS; r++) {
        var cellEl = document.createElement("div");
        cellEl.className = "c4-cell";
        cellEl.style.animationDelay = (120 + (c + (ROWS - 1 - r)) * 32) + "ms";
        col.appendChild(cellEl); // column-reverse puts first child (row 0) at bottom
      }
      boardEl.appendChild(col);
      colEls.push(col);
    }

    discLayer = document.createElement("div");
    discLayer.className = "c4-discs";
    boardEl.appendChild(discLayer);

    svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("class", "c4-svg");
    svgEl.setAttribute("width", geom.w); svgEl.setAttribute("height", geom.h);
    boardEl.appendChild(svgEl);

    ghostEl = document.createElement("div");
    ghostEl.className = "c4-ghost";
    ghostEl.style.display = "none";
    discLayer.appendChild(ghostEl);

    // input
    boardEl.addEventListener("mouseover", onBoardHover);
    boardEl.addEventListener("mouseleave", onBoardLeave);
    boardEl.addEventListener("click", onBoardClick);

    onResize = function () { relayout(); };
    window.addEventListener("resize", onResize);

    document.body.appendChild(rootEl);

    if (!publishing) { publishing = true; requestAnimationFrame(publishDiscs); }
  }

  function relayout() {
    if (!rootEl) return;
    geom = computeGeom();
    boardEl.style.setProperty("--c4-cell", geom.cell + "px");
    boardEl.style.setProperty("--c4-gap", geom.gap + "px");
    boardEl.style.setProperty("--c4-pad", geom.pad + "px");
    svgEl.setAttribute("width", geom.w); svgEl.setAttribute("height", geom.h);
    var discs = discLayer.querySelectorAll(".c4-disc");
    for (var i = 0; i < discs.length; i++) {
      var p = posOf(+discs[i].getAttribute("data-col"), +discs[i].getAttribute("data-row"));
      discs[i].style.left = p.x + "px";
      discs[i].style.top = p.y + "px";
    }
    if (ghostEl.style.display !== "none" && hoverCol >= 0) positionGhost(hoverCol);
    var line = svgEl.querySelector("line[data-c4win]");
    if (line) line.parentNode.removeChild(line); // rare mid-win resize: drop the line rather than misplace it
    updateMask();
  }

  function unmount() {
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
    stopTaunts();
    if (onResize) { window.removeEventListener("resize", onResize); onResize = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = boardEl = discLayer = svgEl = ghostEl = turnEl = null;
    grid = null; colEls = null; discEls = []; occupiedSet = new Set();
    window.__c4Discs = [];
    locked = false; over = false; hoverCol = -1;
    paused = false; pendingCpuMove = false;
  }

  /* ------------------------------------------------------------------ *
   *  Hover affordance (column tint + floating ghost disc)
   * ------------------------------------------------------------------ */
  // Ghost previews the exact socket the disc would land in (lowest empty cell
  // in the hovered column) — same idea as the tic-tac-toe board's faint
  // in-cell hover preview. Returns false if the column is full.
  function positionGhost(col) {
    var row = -1;
    for (var r = 0; r < ROWS; r++) if (grid[r * COLS + col] === EMPTY) { row = r; break; }
    if (row === -1) return false;
    var p = posOf(col, row);
    ghostEl.style.left = p.x + "px";
    ghostEl.style.top = p.y + "px";
    return true;
  }

  function onBoardHover(e) {
    if (locked || over) return;
    var col = e.target && e.target.closest ? e.target.closest(".c4-col") : null;
    if (!col) return;
    var c = +col.getAttribute("data-col");
    if (c === hoverCol) return;
    if (hoverCol >= 0 && colEls[hoverCol]) colEls[hoverCol].classList.remove("c4-hover");
    hoverCol = c;
    col.classList.add("c4-hover");
    sfx("UI_cta-hover");
    ghostEl.style.display = positionGhost(c) ? "block" : "none";
  }

  function onBoardLeave() {
    if (hoverCol >= 0 && colEls && colEls[hoverCol]) colEls[hoverCol].classList.remove("c4-hover");
    hoverCol = -1;
    if (ghostEl) ghostEl.style.display = "none";
  }

  function onBoardClick(e) {
    if (locked || over || !grid || paused) return;
    if (pmode === "1p" && turn !== 1) return;
    if (pmode === "online" && turn !== mySide) return;
    var col = e.target && e.target.closest ? e.target.closest(".c4-col") : null;
    if (!col) return;
    var c = +col.getAttribute("data-col");
    if (grid[(ROWS - 1) * COLS + c] !== EMPTY) { // full column: shake it off
      col.classList.remove("c4-shake");
      void col.offsetWidth; // restart the animation
      col.classList.add("c4-shake");
      sfx("UI_transition-shake");
      return;
    }
    localTurn(c);
  }

  /* ------------------------------------------------------------------ *
   *  Drop animation — fall with gravity ease, squash-and-settle on landing,
   *  board impact nudge, socket flash ring.
   * ------------------------------------------------------------------ */
  function boardNudge() {
    boardEl.animate([
      { transform: "rotate(" + BOARD_TILT + "deg) translateY(0)" },
      { transform: "rotate(" + BOARD_TILT + "deg) translateY(3px)" },
      { transform: "rotate(" + BOARD_TILT + "deg) translateY(0)" }
    ], { duration: 180, easing: "ease-out" });
  }

  function socketFlash(col, row) {
    var p = posOf(col, row);
    var ring = document.createElement("div");
    ring.className = "c4-flash";
    ring.style.left = p.x + "px"; ring.style.top = p.y + "px";
    discLayer.appendChild(ring);
    var a = ring.animate([
      { transform: "scale(.6)", opacity: .9 },
      { transform: "scale(1.35)", opacity: 0 }
    ], { duration: 400, easing: "ease-out" });
    a.finished.catch(function () {}).then(function () { if (ring.parentNode) ring.parentNode.removeChild(ring); });
  }

  function animateDrop(col, row, player) {
    var p = posOf(col, row);
    var disc = document.createElement("div");
    disc.className = "c4-disc " + (player === HUMAN ? "c4-p1" : "c4-p2");
    disc.setAttribute("data-col", col);
    disc.setAttribute("data-row", row);
    disc.setAttribute("data-player", player === HUMAN ? "1" : "2");
    disc.style.left = p.x + "px";
    disc.style.top = p.y + "px";
    discLayer.appendChild(disc);
    discEls.push(disc);

    // Punch a real hole through the (opaque) panel — masking just the cell's own
    // background isn't enough, the panel behind it is opaque too — so the actual WebGL
    // rig (drawn on the canvas behind everything) can show through. Open the whole path
    // above the landing cell for the fall itself, then trim to just the landed cell.
    var r2;
    for (r2 = row; r2 < ROWS; r2++) occupiedSet.add(col + "," + r2);
    updateMask();

    var fallFrom = p.y + geom.pad + geom.cell + geom.gap * 2; // start fully above the panel
    var dur = 160 + 35 * (row + 1);                           // farther fall = longer
    var fall = disc.animate([
      { transform: "translateY(" + (-fallFrom) + "px)" },
      { transform: "translateY(0)" }
    ], { duration: dur, easing: "cubic-bezier(0.26,0,0.60,0.20)" });

    return fall.finished.catch(function () {}).then(function () {
      // Landed: close the still-empty cells above it, keep only the landed one open.
      for (r2 = row + 1; r2 < ROWS; r2++) occupiedSet.delete(col + "," + r2);
      updateMask();
      var squash = disc.animate([
        { transform: "scale(1,1)" },
        { transform: "scale(1.22,0.72)", offset: .35 },
        { transform: "scale(0.94,1.06)", offset: .7 },
        { transform: "scale(1,1)" }
      ], { duration: 260, easing: "cubic-bezier(.17,.89,.32,1.27)" });
      boardNudge();
      socketFlash(col, row);
      sfx(player === HUMAN ? "UI_click-validation" : "UI_custom-select");
      return squash.finished.catch(function () {});
    });
  }

  /* ------------------------------------------------------------------ *
   *  Turn flow
   * ------------------------------------------------------------------ */
  function setTurn(who) {
    if (over || !turnEl) return;
    if (pmode === "local2p") {
      turnEl.textContent = who === 1 ? "PLAYER 1'S TURN" : "PLAYER 2'S TURN";
    } else if (pmode === "online") {
      turnEl.textContent = who === mySide ? "YOUR TURN" : "THEIR TURN!";
    } else {
      turnEl.textContent = who === HUMAN ? "YOUR TURN" : "CPU'S TURN!";
    }
    turnEl.classList.toggle("c4-cpu", who !== mySide);
    turnEl.animate([
      { transform: "scale(.5)", opacity: 0 },
      { transform: "scale(1)", opacity: 1 }
    ], { duration: 350, easing: "cubic-bezier(.17,.89,.32,1.27)" });
  }

  // Called after ANY drop (local click, remote move, or CPU move) has finished
  // animating and settling. Checks for game-end, then flips turn and dispatches
  // the next action for whichever mode is active.
  function afterMove() {
    var w = findWin(grid);
    if (w) return endGame(w);
    if (!legalMoves(grid).length) return endGame(null);
    turn = turn === 1 ? 2 : 1;
    setTurn(turn);
    if (pmode === "1p") {
      if (turn === 2) {
        if (paused) pendingCpuMove = true;
        else thinkTimer = setTimeout(cpuTurn, THINK_MIN + Math.random() * THINK_SPREAD);
      } else { locked = false; if (!paused) showTaunt(); }
    } else if (pmode === "online") {
      locked = (turn !== mySide);
    } else { // local2p
      locked = false;
    }
  }

  function localTurn(col) {
    locked = true;
    onBoardLeave();
    var row = dropInto(grid, col, turn);
    var mover = turn;
    animateDrop(col, row, mover).then(function () {
      return wait(120);
    }).then(function () {
      if (pmode === "online" && window.__net) window.__net.sendMoveIndex(col);
      afterMove();
    });
  }

  // Applies a move received from the remote peer (online mode only). Returns
  // false on anything that looks illegal/out-of-sync so the caller can treat
  // it as a desync rather than silently corrupting local state.
  function remoteMove(col) {
    if (pmode !== "online" || over || !grid) return false;
    if (turn === mySide) return false; // it wasn't their turn
    if (col < 0 || col >= COLS || grid[(ROWS - 1) * COLS + col] !== EMPTY) return false;
    locked = true;
    onBoardLeave();
    var row = dropInto(grid, col, turn);
    animateDrop(col, row, turn).then(function () {
      return wait(120);
    }).then(function () {
      afterMove();
    });
    return true;
  }

  // Ends the game immediately with a given result (used for forfeits/desync from
  // netplay.js). Safe to call even if no game is mounted.
  function abort(result) {
    if (!rootEl) return;
    over = true;
    var resolve = resolveRef;
    unmount();
    if (resolve) resolve(result || "draw");
  }

  function cpuTurn() {
    thinkTimer = null;
    var col = chooseMove(grid);
    var row = dropInto(grid, col, CPU);
    animateDrop(col, row, CPU).then(function () {
      return wait(120);
    }).then(function () {
      afterMove();
    });
  }

  /* ------------------------------------------------------------------ *
   *  Win / draw / exit choreography
   * ------------------------------------------------------------------ */
  function drawWinLine(w, resultColor) {
    var a = posOf(w.cells[0] % COLS, Math.floor(w.cells[0] / COLS));
    var b = posOf(w.cells[3] % COLS, Math.floor(w.cells[3] / COLS));
    var half = geom.cell / 2;
    var x1 = a.x + half, y1 = a.y + half, x2 = b.x + half, y2 = b.y + half;
    // extend slightly past the end discs, comic strike-through style
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ext = geom.cell * 0.3;
    x1 -= dx / len * ext; y1 -= dy / len * ext;
    x2 += dx / len * ext; y2 += dy / len * ext;
    len += ext * 2;
    var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", resultColor);
    line.setAttribute("stroke-width", Math.max(6, geom.cell * 0.16));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("data-c4win", "1");
    line.style.strokeDasharray = len;
    line.style.strokeDashoffset = len;
    svgEl.appendChild(line);
    line.animate([
      { strokeDashoffset: len },
      { strokeDashoffset: 0 }
    ], { duration: 650, easing: "cubic-bezier(.26,1,.48,1)", fill: "forwards" });
  }

  function endGame(w) {
    over = true; locked = true;
    stopTaunts();
    onBoardLeave();
    var result = !w ? "draw" : (w.player === mySide ? "win" : "lose");
    var held;
    if (w) {
      rootEl.classList.add("c4-dim");
      for (var i = 0; i < w.cells.length; i++) {
        var d = discLayer.querySelector('.c4-disc[data-col="' + (w.cells[i] % COLS) + '"][data-row="' + Math.floor(w.cells[i] / COLS) + '"]');
        if (d) d.classList.add("c4-win");
      }
      var colors = (play._opts && play._opts.results) || (window.__xoxBridge && window.__xoxBridge.results);
      var hex = "#3ee63e";
      try {
        var col = result === "win" ? colors.win.color : colors.lose.color;
        hex = "#" + col.string;
      } catch (e) { /* keep fallback */ }
      drawWinLine(w, hex);
      sfx("EVENT_tictactoe");
      held = wait(1600);
    } else {
      rootEl.classList.add("c4-draw");
      held = wait(1100);
    }
    held.then(function () {
      var out = boardEl.animate([
        { transform: "rotate(" + BOARD_TILT + "deg) scale(1)", opacity: 1 },
        { transform: "rotate(6deg) scale(.6)", opacity: 0 }
      ], { duration: 500, easing: "cubic-bezier(.6,-.28,.73,.04)", fill: "forwards" });
      turnEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
      return out.finished.catch(function () {});
    }).then(function () {
      var resolve = resolveRef;
      unmount();
      if (resolve) resolve(result);
    });
  }

  /* ------------------------------------------------------------------ *
   *  Entrance choreography
   * ------------------------------------------------------------------ */
  function animateIn() {
    var a = boardEl.animate([
      { transform: "rotate(-14deg) scale(.2)", opacity: 0 },
      { transform: "rotate(" + BOARD_TILT + "deg) scale(1)", opacity: 1 }
    ], { duration: 900, easing: "cubic-bezier(.17,.89,.32,1.27)" });
    turnEl.animate([
      { transform: "translateY(-18px) scale(.6)", opacity: 0 },
      { transform: "none", opacity: 1 }
    ], { duration: 600, easing: "cubic-bezier(.17,.89,.32,1.27)", delay: 250, fill: "backwards" });
    return a.finished.catch(function () {});
  }

  /* ------------------------------------------------------------------ *
   *  Public API
   * ------------------------------------------------------------------ */
  function play(opts) {
    opts = opts || {};
    play._opts = opts;
    unmount(); // safety: never two boards at once
    pmode = opts.players || "1p";
    mySide = (pmode === "online") ? (opts.side || 1) : 1;
    turn = 1;
    var tier = AI_TIERS[opts.difficulty] || AI_TIERS.medium;
    DEPTH = tier.depth; BLUNDER = tier.blunder;
    return new Promise(function (resolve) {
      resolveRef = resolve;
      grid = newBoard();
      locked = true; over = false; hoverCol = -1;
      mount();
      // guarantee the pale-green backdrop the spec calls for (versus can end on blue)
      try {
        if (opts.setClearColor && opts.colors && opts.colors.pink)
          opts.setClearColor.apply(null, opts.colors.pink.glsl.concat([1]));
      } catch (e) { /* cosmetic only */ }
      animateIn().then(function () {
        if (over) return; // unmounted mid-entrance
        setTurn(turn);
        locked = (pmode === "online" && turn !== mySide) ? true : false; // player 1 always opens
        scheduleTaunts();
      });
    });
  }

  injectStyle();

  window.__c4 = {
    get mode() { return mode; },
    set mode(m) { if (m === "xo" || m === "c4") { mode = m; refreshPicker(); } },
    get players() { return players; },
    set players(p) { if (p === "1p" || p === "local2p" || p === "online") { players = p; refreshPicker(); } },
    get difficulty() { return difficulty; },
    set difficulty(d) { if (d === "easy" || d === "medium" || d === "hard") { difficulty = d; refreshPicker(); } },
    get step() { return step; },
    resetWizard: function () { setStep("game"); refreshPicker(); },
    pickerHTML: pickerHTML,
    play: play,
    unmount: unmount,
    remoteMove: remoteMove,
    abort: abort,
    setPaused: setPaused,
    // exposed for headless testing / debugging only
    _test: {
      chooseMove: function (b) { return chooseMove(b); },
      findWin: findWin,
      dropInto: dropInto,
      legalMoves: legalMoves,
      COLS: COLS, ROWS: ROWS
    }
  };
})();
