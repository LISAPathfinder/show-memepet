// 生成 renderer/emoji-catalog.js：完整 Windows 可渲染 emoji 目录（剔除肤色变体）。
// 数据源 unicode-emoji-json（jsdelivr），产物供 skin-picker 的 emoji 皮肤映射挑选。
// 运行：node tools/gen-emoji-catalog.js
const https = require('https');
const fs = require('fs');
const path = require('path');

const URL = 'https://cdn.jsdelivr.net/npm/unicode-emoji-json@0.4.0/data-by-group.json';
const OUT = path.join(__dirname, '..', 'renderer', 'emoji-catalog.js');

https
  .get(URL, (res) => {
    if (res.statusCode !== 200) {
      console.error('HTTP', res.statusCode);
      process.exit(1);
    }
    let d = '';
    res.on('data', (c) => (d += c));
    res.on('end', () => {
      const data = JSON.parse(d);
      // 兼容两种形态：npm 版是 {组名: [条目]}，gh 版是 [{name, emojis}]
      const groups = Array.isArray(data)
        ? data.map((g) => g.emojis)
        : Object.values(data);
      const out = [];
      for (const emojis of groups) {
        for (const e of emojis) {
          if (e.skin_tone_support) continue; // 肤色变体不进目录
          out.push(e.emoji);
        }
      }
      const uniq = [...new Set(out)];
      const body = uniq.map((e) => JSON.stringify(e)).join(',\n');
      const header =
        '// Windows (Segoe UI Emoji) 支持的完整 emoji 目录，由 tools/gen-emoji-catalog.js 生成（剔除肤色变体）。\n' +
        '// skin-picker 的 emoji 皮肤映射从这个目录选择；请勿手改，重新生成用 node tools/gen-emoji-catalog.js\n' +
        'window.EMOJI_CATALOG = [\n';
      fs.writeFileSync(OUT, header + body + '\n];\n');
      console.log('entries:', uniq.length, '->', OUT);
    });
  })
  .on('error', (e) => {
    console.error(e.message);
    process.exit(1);
  });
