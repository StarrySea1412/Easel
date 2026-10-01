# Easel 猫角色：第一轮蒙皮样板

原创曲面建模源码为 `make-character.mjs`，导出结果为 `easel-cat-study.glb`。没有第三方模型、贴图、模型生成 API 或收费素材。作者身份、来源和样板状态也写在 GLB extras 中。源文件是本项目资产；可随项目许可管理。

这是供真实浏览器检查和继续造型调整的**首轮建模样板**，尚未声明为完成美术验收的最终精制资产，也未替换多人办公室全体角色。

## 重建与结构验收

在仓库根目录运行：

```powershell
node web/frontend/src/assets/office-character/make-character.mjs
node web/frontend/src/assets/office-character/validate-character.mjs
```

使用前端已有 Three.js，不需要 Blender。模型可由支持 glTF 2.0 的建模软件导入后继续编辑。程序化源文件保留头颅、脸颊、针织衫、袖子、掌部、手指和坐姿轮廓的曲面控制点；这些角色表面不是 SphereGeometry 拼装。

## 资产内容

- 29 根骨骼，身体/头/耳/上臂/前臂/手掌/手指/拇指/腿/脚/尾部。
- 真实 JOINTS_0 / WEIGHTS_0 和 inverse bind matrices；关节周围权重连续混合。
- 毛色、脸部浅色、花纹、针织衫、领口/袖口、裤子、鞋子等命名材质。
- 双眼和高光的 `Blink` morph target。
- `Read`、`Type`、`Review` 基础动画片段；样板运行时以岗位接触点约束双手并组织 24 秒演示。
- `Grip_L`、`Grip_R`、`Gaze`、`Paper_support_L` 语义锚点。
- 具体字节数和网格统计在 `easel-cat-study.manifest.json`。

角色为坐姿绑定姿态，Y 轴向上，脸朝 +Z，单位米。当前版本不提供完整站立/行走/取放物动作，服装属于一套已绑定的针织衫，毛色和服装颜色可即时修改。未把变色宣称为自由换装。

## 独立样板入口

`src/components/agent-office/character-study/CharacterStudy.tsx` 导出 `CharacterStudy`，支持 `preset`（`research`、`writing`、`design`）、`onPresetChange`、`onClose`。不要把此组件状态当作后台执行证据。

三种工位改变桌型/设备/资料和手部接触位置。研究工位为侧置资料屏与打开的书本；文案工位为键盘、右侧显示器与稿纸；设计工位为倾斜数位板、手持笔、色卡与样张架。屏幕内容固定用于布局演示，界面明确标注，未假造任务产出。样板形象单独保存在浏览器 `easel.character-study.appearance.v1`。

## 验收边界

`validate-character.mjs` 检查合法 GLB、真实骨骼、权重归一、顶点有限、手指旋转导致实际网格变形、眨眼和锚点；不证明美术质量、手部接触无穿插、性能指标或真实后端任务成功。真实浏览器正/侧/背/工作/手部机位与三种岗位、保存/撤销/返回由集成人员逐项检查后另行记录。
