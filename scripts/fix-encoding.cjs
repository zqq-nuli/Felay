const fs = require('fs');
const filePath = 'packages/gui/src/App.tsx';
let content = fs.readFileSync(filePath, 'utf8');

// Fix missing '<' before closing tags
// The corruption ate the '<' character along with the last CJK char
const tagFixes = [
  // h3, h4 closing tags
  ['机器人配置/h3>', '机器人配置</h3>'],
  ['交互）/h4>', '交互）</h4>'],
  ['Webhook）/h4>', 'Webhook）</h4>'],
  // button closing tags
  ['添加双向机器人/button>', '添加双向机器人</button>'],
  // p closing tags
  ['不可撤销。/p>', '不可撤销。</p>'],
  ['启动后生效/p>', '启动后生效</p>'],
  // span closing tags
  ['已配置/span>', '已配置</span>'],
  ['未安装/span>', '未安装</span>'],
  ['未配置/span>', '未配置</span>'],
  ['配置文件：/span>', '配置文件：</span>'],
  ['通知脚本：/span>', '通知脚本：</span>'],
  ['Hook 脚本：/span>', 'Hook 脚本：</span>'],
  ['添加：/span>', '添加：</span>'],
  ['hooks 配置：</span>', 'hooks 配置：</span>'],  // already correct, skip
];

let totalFixed = 0;
for (const [search, replace] of tagFixes) {
  if (search === replace) continue;
  let count = 0;
  while (content.includes(search)) {
    content = content.replace(search, replace);
    count++;
  }
  if (count > 0) {
    console.log(`  Fixed "${search}" → "${replace}" (${count}x)`);
    totalFixed += count;
  }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log(`\nTotal: ${totalFixed} tag fixes applied`);
