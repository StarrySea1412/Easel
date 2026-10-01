# Easel Studio 前端

这是 [StarrySea1412/Easel](https://github.com/StarrySea1412/Easel) 的创作者工作台前端，当前定制开发分支为 [`codex/creator-workflow`](https://github.com/StarrySea1412/Easel/tree/codex/creator-workflow)。项目采用 React 19、TypeScript、Vite 8 和 Three.js，提供创作对话、生图工坊、内容库、Agent 办公室、发布与数据页面。

完整安装、模型配置与 Windows 启动方式见[项目说明](../../README.md)和 [Windows 使用说明](../../WINDOWS-START-HERE.md)。本项目基于 [ZJU-REAL/Easel](https://github.com/ZJU-REAL/Easel)；第三方来源见[致谢](../../docs/ACKNOWLEDGMENTS.md)，许可证见 [LICENSE](../../LICENSE)。

## 安装与运行

先按项目说明安装 Python、兼容的 Node.js、项目依赖及需要的 OpenClaw 环境。在仓库根目录执行：

```bash
cd web/frontend
npm ci
npm run build
cd ../..
easel web --port 7860
```

在浏览器打开 `http://localhost:7860`。FastAPI 后端会读取 `web/frontend/dist` 的构建结果，并提供同源 `/api` 接口。修改前端后需重新构建，再刷新页面；模型、生图与社交账号功能需要各自的真实配置或登录会话。

## 开发与检查

以下命令均在 `web/frontend` 目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Vite 开发服务与热更新 |
| `npm run build` | 执行 TypeScript 检查并输出 `dist/` |
| `npm test` | 运行前端 Node 测试及 Agent 办公室测试 |
| `npm run lint` | 使用 Oxlint 检查源码 |
| `npm run preview` | 预览已构建的前端静态文件 |

当前 `vite.config.ts` 没有配置后端代理，API 客户端按页面路径请求同源接口。因此单独运行 `npm run dev` 或 `npm run preview` 不能验证完整后端功能；完整联调使用上面的 FastAPI 工作台入口，或先按本地环境配置开发代理。

## 代码入口

- [`src/App.tsx`](src/App.tsx)：页面切换、懒加载、会话及首次使用引导。
- [`src/components/`](src/components/)：工作台各页面；[`agent-office/`](src/components/agent-office/) 包含办公室场景与交互。
- [`src/hooks/`](src/hooks/)：页面状态及控制逻辑。
- [`src/lib/api.ts`](src/lib/api.ts)：后端 API 与流式会话请求。
- [`src/styles/`](src/styles/)：全局样式与页面样式；界面原则见 [`DESIGN.md`](../../DESIGN.md)。
- [`tests/`](tests/)：前端行为回归测试。

提交改动前遵循[贡献指南](../../CONTRIBUTING.md)。页面验收需要逐项检查菜单、链接与跳转，并说明检查使用了真实浏览器、真实后端还是模拟数据；测试或静态预览通过不代表平台登录、模型生成或发布已成功。
