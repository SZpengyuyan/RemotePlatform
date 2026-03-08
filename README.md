# 机器人远程操控仿真与可视化平台

用于演示"网络环境变化如何影响远程机械臂操控"的极简闭环平台（前端控制 + 后端网络仿真 + 3D可视化）。

## 启动（唯一方式）

先确认 Docker Desktop 已启动，然后在项目根目录执行：

```bash
docker compose up --build
```

访问地址：
- 前端：`http://localhost:8080`
- 后端健康检查：`http://localhost:8000/health`

停止：

```bash
docker compose down
```

## 详细文档

完整架构、模块职责、当前项目进度与验证方法见：`项目最精简架构与启动说明.md`
