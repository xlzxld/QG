import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 纯 ASCII 的批处理内容。
// 关键：内容里绝对不能出现非 ASCII 字符（包括 BOM），
// 否则 cmd.exe 按字节解析时会错位，把后续代码当命令执行。
const BAT = [
  '@echo off',
  'rem ==================================================================',
  'rem  Grab Launcher  (ASCII only, on purpose)',
  'rem ------------------------------------------------------------------',
  'rem  cmd.exe parses .bat files byte-by-byte. Any multi-byte UTF-8',
  'rem  character (e.g. Chinese) breaks its quote/paren matching, and the',
  'rem  remainder of the file gets executed as garbage commands.',
  'rem  All Chinese text is printed by the Node script instead.',
  'rem ==================================================================',
  '',
  'rem Switch console to UTF-8 so Node output renders correctly.',
  'chcp 65001 >nul 2>&1',
  '',
  'setlocal',
  'title Grab Launcher',
  '',
  'cd /d "%~dp0"',
  '',
  'rem ---- locate Node.js --------------------------------------------',
  'set "NODE_EXE="',
  '',
  'for /f "delims=" %%i in (\'where node 2^>nul\') do (',
  '    if not defined NODE_EXE set "NODE_EXE=%%i"',
  ')',
  '',
  'if not defined NODE_EXE (',
  '    if exist "C:\\Users\\5600\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe" (',
  '        set "NODE_EXE=C:\\Users\\5600\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe"',
  '    )',
  ')',
  '',
  'if not defined NODE_EXE (',
  '    echo.',
  '    echo   [ERROR] Node.js not found.',
  '    echo.',
  '    echo   Install Node.js, or add it to PATH.',
  '    echo.',
  '    pause',
  '    exit /b 1',
  ')',
  '',
  'rem ---- Playwright browser cache ----------------------------------',
  'if not defined PLAYWRIGHT_BROWSERS_PATH (',
  '    set "PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\\ms-playwright"',
  ')',
  '',
  'rem ---- run -------------------------------------------------------',
  '"%NODE_EXE%" "scripts\\grab-launcher.mjs" %*',
  'set "EXITCODE=%ERRORLEVEL%"',
  '',
  'if not "%EXITCODE%"=="0" (',
  '    echo.',
  '    echo   [INFO] launcher exited with code %EXITCODE%',
  '    echo.',
  '    pause',
  ')',
  '',
  'endlocal',
  '',
].join('\r\n');

// 用 latin1 写出，确保字节级就是纯 ASCII（无 BOM、无多字节序列）
const target = path.join(ROOT, '启动.bat');
fs.writeFileSync(target, Buffer.from(BAT, 'latin1'));

// 校验
const buf = fs.readFileSync(target);
const nonAscii = [];
for (let i = 0; i < buf.length; i++) {
  if (buf[i] > 127) nonAscii.push({ offset: i, byte: buf[i] });
}
const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

console.log(`已写入 ${path.relative(ROOT, target)}`);
console.log(`  字节数        : ${buf.length}`);
console.log(`  非 ASCII 字节 : ${nonAscii.length}${nonAscii.length ? ' ← 必须为 0！' : ' ✅'}`);
console.log(`  UTF-8 BOM     : ${hasBom ? '有 ← 必须去掉！' : '无 ✅'}`);
console.log(`  行尾          : CRLF ✅`);

process.exit(nonAscii.length === 0 && !hasBom ? 0 : 1);
