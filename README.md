# 机器人远程操控仿真与可视化平台

用于演示“网络环境变化如何影响远程机械臂操控”的极简闭环平台。

前端负责控制与 3D 可视化，后端负责网络仿真与指令执行，二者通过 WebSocket 实时通信。

## 项目特性

- Docker 单命令启动（前后端一体化编排）。
- 支持三档网络场景切换，实时观察时延、抖动、丢包等指标变化。
- 支持 3D 机械臂控制与状态回传（关节控制 + 末端目标控制）。
- 支持模型资产自动检测：有真实模型用真实模型，无模型自动回退内置几何臂。
- 支持可选 MuJoCo 物理引擎，且与默认轻量模式协议兼容。

## 启动（唯一方式）

先确认 Docker Desktop 已启动，然后在项目根目录执行：

```bash
docker compose up --build
```

访问地址：

- 前端：http://localhost:8080
- 后端健康检查：http://localhost:8000/health

停止：

```bash
docker compose down
```

## 快速验证（建议首次启动后执行）

1. 打开前端页面，确认控制面板与 3D 视图正常加载。
2. 在前端切换网络场景（良好/中等/恶劣），观察指标面板数值变化。
3. 点击机械臂控制按钮，确认关节状态和轨迹有响应。
4. 访问后端健康检查，确认返回健康状态。

## 启用 MuJoCo 模式（可选）

默认运行在 lightweight 模式。若需启用 MuJoCo，请使用以下方式之一。

1. 一次性启动（推荐）

PowerShell：

```powershell
$env:INSTALL_MUJOCO="true"
$env:PHYSICS_ENGINE="mujoco"
docker compose up --build
```

Bash：

```bash
INSTALL_MUJOCO=true PHYSICS_ENGINE=mujoco docker compose up --build
```

2. 分步启动（等价）

```bash
docker compose build --build-arg INSTALL_MUJOCO=true backend
```

然后设置运行模式再启动：

PowerShell：

```powershell
$env:PHYSICS_ENGINE="mujoco"
docker compose up
```

Bash：

```bash
PHYSICS_ENGINE=mujoco docker compose up
```

3. 恢复默认轻量模式

PowerShell：

```powershell
$env:PHYSICS_ENGINE="lightweight"
docker compose up
```

或重开终端后直接执行：

```bash
docker compose up
```

说明：

- docker compose 不支持 -e（例如 docker compose -e ... 会报错）。
- 若使用 up --build 启动 MuJoCo，需同时设置 INSTALL_MUJOCO=true，否则会按默认值重建为 lightweight 依赖。
- 若 MuJoCo 安装失败或不可用，系统会自动回退到 lightweight 模式。

## 常见问题

1. 启动失败，提示端口占用

- 检查本机 8080/8000 端口是否被占用。
- 停止旧容器后重试：docker compose down，再执行 docker compose up --build。

2. 前端构建报 Rollup 可选依赖错误

- 某些环境下 npm 可选依赖解析不稳定，可重试构建。
- 若持续失败，可参考 frontend/Dockerfile 中的兼容安装逻辑。

3. 在 PowerShell 中设置变量后不生效

- 确认在同一个终端窗口中执行设置与启动命令。
- 重新开一个终端窗口并重新设置环境变量后再启动。

## 详细文档

完整架构、模块职责、当前项目进度与验证方法见：项目最精简架构与启动说明.md
