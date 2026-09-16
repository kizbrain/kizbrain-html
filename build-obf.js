#!/usr/bin/env node
/**
 * KIZBRAIN 난독화 빌드 스크립트 (2026-09-17)
 *
 * 하는 일
 *  1) 원본 HTML의 메인 <script>에서 `const INJECTED_CONFIG = {...};` 블록을 떼어내
 *     "난독화하지 않는" 별도 <script>로 앞에 둔다  → Worker 치환 정규식이 항상 매칭됨
 *  2) 나머지 스크립트만 javascript-obfuscator로 난독화
 *  3) 결과물이 Worker 치환에 통과하는지 자체 검증 후 dist/ 에 저장
 *
 * 사용법 (저장소 루트에서)
 *   npm i -D javascript-obfuscator
 *   node build-obf.js kizbrain_flash_basic.html kizbrain_flash_master.html
 *   → dist/kizbrain_flash_basic.obf.html, dist/kizbrain_flash_master.obf.html
 *
 * 규칙: INJECTED_CONFIG 정의 모양(키 : "__TOKEN__")은 원본에서 바꾸지 말 것.
 */
const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const OUT_DIR = "dist";
const TOKENS = {
  academyName: "__ACADEMY_NAME__",
  contactName: "__CONTACT_NAME__",
  startDate: "__START_DATE__",
  expirationDate: "__EXPIRATION_DATE__",
  lastSyncTime: "__LAST_SYNC_TIME__",
};

const OBF_OPTIONS = {
  compact: true,
  target: "browser",
  renameGlobals: false,          // 필수: INJECTED_CONFIG 등 전역 이름 보존
  identifierNamesGenerator: "hexadecimal",
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  stringArrayRotate: true,
  stringArrayShuffle: true,
  splitStrings: false,
  reservedStrings: ["^__[A-Z_]+__$"],
  controlFlowFlattening: false,  // 켜면 애니메이션 타이밍 성능 저하 가능
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  unicodeEscapeSequence: false,
  seed: 20260917,                // 같은 입력 → 같은 출력 (커밋 diff 최소화)
};

// worker.js injectConfig 와 동일한 정규식 (검증용)
function workerPut(h, key, tok, val) {
  return h.replace(new RegExp(`(["']?${key}["']?\\s*:\\s*)(["'])${tok}\\2`), `$1$2${val}$2`);
}

function build(file) {
  const src = fs.readFileSync(file, "utf8");

  // 인라인(src 없는) script 중 INJECTED_CONFIG 를 가진 것
  const scriptRe = /<script>([\s\S]*?)<\/script>/g;
  let m, target = null;
  while ((m = scriptRe.exec(src))) {
    if (m[1].includes("const INJECTED_CONFIG")) { target = m; break; }
  }
  if (!target) throw new Error(`${file}: INJECTED_CONFIG 를 가진 <script> 없음`);

  const js = target[1];
  const cfgRe = /const INJECTED_CONFIG\s*=\s*\{[\s\S]*?\};/;
  const cfgMatch = js.match(cfgRe);
  if (!cfgMatch) throw new Error(`${file}: INJECTED_CONFIG 블록 형식 인식 실패`);
  const cfgBlock = cfgMatch[0];
  for (const [k, t] of Object.entries(TOKENS)) {
    if (!new RegExp(`${k}\\s*:\\s*"${t}"`).test(cfgBlock))
      throw new Error(`${file}: 설정 블록에 ${k} : "${t}" 가 없음`);
  }

  const rest = js.replace(cfgRe, "/* INJECTED_CONFIG: 위의 별도 <script> 에 정의 */");
  let obf = JavaScriptObfuscator.obfuscate(rest, OBF_OPTIONS).getObfuscatedCode();
  obf = obf.replace(/<\/script/gi, "<\\/script"); // HTML 파서 조기 종료 방지

  const replacement =
    `<script>\n/* 배포 시 Worker가 치환 — 난독화 제외 영역 */\n${cfgBlock}\n</script>\n` +
    `<script>${obf}</script>`;
  const out =
    src.slice(0, target.index) + replacement + src.slice(target.index + target[0].length);

  // ── 자체 검증 ──
  let sim = out;
  for (const [k, t] of Object.entries(TOKENS)) sim = workerPut(sim, k, t, "TEST_" + k);
  const left = Object.values(TOKENS).filter((t) => sim.includes(`"${t}"`) || sim.includes(`'${t}'`));
  if (left.length) throw new Error(`${file}: Worker 치환 시뮬레이션 실패 — 남은 토큰 ${left}`);
  new Function(obf.replace(/<\\\/script/g, "</script")); // 문법 검사

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, path.basename(file).replace(/\.html$/, ".obf.html"));
  fs.writeFileSync(outFile, out);
  const title = (src.match(/<title>(.*?)<\/title>/) || [])[1];
  console.log(`✔ ${file} → ${outFile}  [${title}]  ${(out.length / 1024).toFixed(0)}KB, 치환검증 OK`);
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("사용법: node build-obf.js <원본.html> [...]");
  process.exit(1);
}
let fail = 0;
for (const f of files) {
  try { build(f); } catch (e) { fail++; console.error("✘ " + e.message); }
}
process.exit(fail ? 1 : 0);
