# Shenlin's Home

沈秣与何尘逸的小屋，一个运行在 Termux / Node.js 环境里的本地聊天应用。

## 功能

- Gemini API 后端
- SSE 流式回复
- 对话气泡展示
- 设置页：模型、温度等配置
- 记忆库页：增删改查、导入导出、去重
- 敏感配置与聊天记录通过 .gitignore 排除

## 本地运行

安装依赖：

npm install

启动服务：

node server.js

然后用浏览器打开：

http://localhost:3000

## 不应提交的敏感文件

以下文件不要提交到 GitHub：

config.json
config.json.bak
data/messages.json
valid-keys
new-keys
*.bak
screen-state
screen-recent

## GitHub 仓库

https://github.com/Lin-0704/shenlin-home
