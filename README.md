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

## 分步改造（MuJoCo思路迁移）

当前已完成：
- 前端支持真实模型资产加载（若存在 `frontend/public/assets/robot/ur5e.glb` 则优先使用）。
- 若模型文件不存在，自动回退到内置几何机械臂，保证演示与启动流程不受影响。
- 后端已引入关节轨迹插值（`robot_joint_control` 改为分步 waypoint 执行）。
- 已新增末端目标控制（轻量 IK）：前端发送末端目标，后端逆解并映射到关节轨迹。

后续建议顺序：
- 第4步：按需引入MuJoCo运行时到后端容器。
