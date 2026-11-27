// Normal (not scheduled) Code sessions get the app's idle pause after 30 minutes when the server flag
// gives no timeout of its own; a session with Remote Control on is never paused. See patch.js.
const IDLE_MS = 30 * 60 * 1000;

function patchIdle(src, once) {
  // r1(e): the server flag's "not a positive number" branch returns 0 (no timer). Make it 30 min for a
  // session that is not marked `remote`; a positive server value is left as it is.
  src = once(src, /(function [\w$]+\(([\w$]+)\)\{if\(\2\.unused\)return [\w$]+;if\(\2\.unattended\)return [\w$]+;let ([\w$]+)=[\w$]+\.[\w$]+\("\d+",null\);return typeof \3!="number"\|\|Number\.isNaN\(\3\)\|\|\3<=0\?)0(:)/,
    (m, head, e, n, colon) => `${head}(${e}.remote?0:${IDLE_MS})${colon}`, "idle timeout default");
  // i1(e): tell r1 whether the live session has Remote Control on (or is switching it on).
  src = once(src, /(idleTimeoutMs:([\w$]+)=>[\w$]+\(\{unattended:[^{}]*?\([\w$]+,([\w$]+\.held)\)[^{}]*?unused:[^{}]*?===!0)\}\)/,
    (m, head, r, held) => `${head},remote:${r}!==void 0&&(${held}(${r})?.remoteControlEnabled===!0||${held}(${r})?.remoteControlConnecting===!0)})`, "idle remote control");
  return src;
}

exports.patchIdle = patchIdle;
