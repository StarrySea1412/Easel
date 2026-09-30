# Windows 交付验证记录（2026-09-30）

本轮验证在当前 Windows 开发机的独立目录进行，**不是干净虚拟机测试**。Python 3.12、兼容 Node.js、Git、FFmpeg 已可用；安装链路仍在新版本目录创建独立 venv 与 OpenClaw npm prefix，复用本机可用的下载缓存/浏览器内核。

## 交付入口

- ZIP：解压后双击 `Start-Easel.cmd`；首次自动初始化，也可先双击 `Install-Easel.cmd`。
- EXE：原生安装向导；安装完打开工作台，或双击安装根目录 `Start-Easel.cmd`。
- 首次安装需要联网，不是离线运行时包；正式账号与模型需要用户自己配置。
- 独立数据和 OpenClaw 状态保存在安装 `data` 目录。Web 端口冲突自动选择空闲端口，保留原服务。
- 不注册 Windows 卸载项；移除与程序版本恢复方法见根目录 `WINDOWS-START-HERE.md`。

## 已完成的脚本级验证

- Python 3.11：bootstrapper / runtime data paths / gateway resolver 合计 **172 passed**。
- Python 3.12：Windows 发行包测试 **24 passed**；启动器含真实占用端口不干扰原服务、返回页面和状态共同核验用例。
- 修复 PowerShell 与 Python 的 gateway 端口解析漂移，非法端口和小数配置均拒绝。
- 恢复 Windows Python 3.10/3.11 的 junction 识别，迁移时不跟随源链接、不写入目标链接。
- 包含源码 commit 与 tracked sourceDirty 标识；仅打包 Git 索引文件以及已构建前端，排除 `.tools`、`data`、私有资料和凭据文件。

## 实际安装验证

进行中：基线 `0.2.1` 安装至 `.scratch/release-install-qa`，用于随后以最终 `0.2.2` EXE 验证升级。最终产物、退出码、启动地址及数据保留结果将在运行完成后补录。此段不代表安装通过。

## 测试边界

应用页面与安装健康检查不等同于社交平台账号授权成功，也不代表付费模型真实调用通过。项目没有独立管理员账号登录系统，`gaojitest / gaoji` 不适用于本项目，未虚构管理员入口。不会修改其他项目的 7860 服务或复制现有真实账号凭据进入发行包。
